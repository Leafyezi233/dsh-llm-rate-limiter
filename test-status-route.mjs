/**
 * Regression tests for the self-registered status route (Option E).
 *
 * Run: node test-status-route.mjs
 *
 * Background — the DSH 0.1.5-rc.3 regression this suite pins down:
 *   @deepseek-ai/dsh-client-connection changed its own `inject` from
 *   ["webServer", "credentials"] to ["credentials"], but
 *   HostConnectionService.register() still dereferences `owner.webServer`.
 *   Cordis rebinds a cross-fiber service's `ctx` to the *reader's* fiber, so
 *   `connection.rpc.handle(...)` throws:
 *       cannot get property "webServer" without inject
 *   The plugin swallowed that in a try/catch, so the channel silently never
 *   mounted and the live panel showed "重试中" forever.
 *
 * This suite has three layers:
 *   1. unit      — createChannelRoute request-shape decisions, no DSH needed (runs in CI)
 *   2. simulated — the plugin falls back and mounts when rpc.handle throws the
 *                  exact 0.1.5 message, and prefers rpc.handle when it works
 *   3. real      — boots the REAL @deepseek-ai/dsh-client-connection + Cordis
 *                  when resolvable, proving the fallback against the real bug
 *                  (auto-skips when the DSH install is absent, e.g. in CI)
 */
import { createRequire } from "node:module";
import { createChannelRoute, createStatusChannel, endpointFromPath, CHANNEL } from "./lib/status-rpc.js";
import { apply, name, SETTINGS_NS } from "./lib/index.js";

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  \u2713 ${label}`); }
  else { failed += 1; console.log(`  \u2717 ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
}
function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ── node:http doubles ──────────────────────────────────────────────── */

/** A minimal IncomingMessage: async-iterable body + headers/method/url. */
function makeReq({ method = "POST", url = "/llm-rate-limiter/snapshot", headers = {}, body = "" } = {}) {
  const chunks = body === "" ? [] : [Buffer.from(body)];
  return {
    method,
    url,
    headers: { "content-type": "application/json", ...headers },
    destroy() {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
}

/** A minimal ServerResponse recording the status, headers, and body. */
function makeRes() {
  const res = {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writableEnded: false,
    _listeners: [],
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(chunk) { res.body = chunk === undefined ? "" : String(chunk); res.writableEnded = true; },
    on(event, fn) { if (event === "close") res._listeners.push(fn); },
  };
  return res;
}

/** Run one route request and return { status, body, headers }. */
async function send(route, options) {
  const req = makeReq(options);
  const res = makeRes();
  await route.handler(req, res);
  let parsed;
  try { parsed = JSON.parse(res.body); } catch { parsed = undefined; }
  return { status: res.statusCode, body: res.body, parsed, headers: res.headers };
}

/** A client-request envelope as the browser sends it. */
function envelope(method, payload = {}) {
  return JSON.stringify({ type: "client-request", rpcId: "rpc-1", method, payload });
}

const allow = () => undefined;

/**
 * One protocol rule both carriers enforce and every real caller satisfies:
 * the envelope's `method` must equal the URL's endpoint (the browser caller
 * sends the same string for both). A mismatch is a `gateway/bad-request`
 * failure, not a 404 — see the dedicated assertions below.
 */

/* ══ 1. endpointFromPath grammar (mirrors the framework) ══════════════ */
console.log("\n[1] endpointFromPath");
{
  eq("simple endpoint", endpointFromPath(CHANNEL, "/llm-rate-limiter/snapshot"), "snapshot");
  eq("nested endpoint", endpointFromPath(CHANNEL, "/llm-rate-limiter/a/b"), "a/b");
  eq("channel root is not an endpoint", endpointFromPath(CHANNEL, "/llm-rate-limiter"), undefined);
  eq("channel root with slash", endpointFromPath(CHANNEL, "/llm-rate-limiter/"), undefined);
  eq("other channel", endpointFromPath(CHANNEL, "/other/snapshot"), undefined);
  eq("prefix but not a member", endpointFromPath(CHANNEL, "/llm-rate-limiterx/snapshot"), undefined);
  eq("dot segment rejected", endpointFromPath(CHANNEL, "/llm-rate-limiter/../x"), undefined);
  eq("empty segment rejected", endpointFromPath(CHANNEL, "/llm-rate-limiter/a//b"), undefined);
  eq("space rejected", endpointFromPath(CHANNEL, "/llm-rate-limiter/a b"), undefined);
  eq("query string not part of the pathname", endpointFromPath(CHANNEL, "/llm-rate-limiter/snapshot"), "snapshot");
  check("underscore/dollar/dot/hyphen accepted", endpointFromPath(CHANNEL, "/llm-rate-limiter/a_b$c.d-e") === "a_b$c.d-e");
}

/* ══ 2. createChannelRoute request-shape decisions ════════════════════ */
console.log("\n[2] createChannelRoute shapes");
{
  const handler = createStatusChannel({ buildSnapshot: () => ({ rev: 1 }), resetTotals: () => {} });
  const route = createChannelRoute({ channel: CHANNEL, handler, reject: allow });

  eq("route kind is prefix", route.kind, "prefix");
  eq("route path is the channel", route.path, CHANNEL);
  check("route handler is a function", typeof route.handler === "function");

  // 200 + server-response on the happy path
  const ok = await send(route, { body: envelope("snapshot") });
  eq("POST snapshot -> 200", ok.status, 200);
  eq("envelope type echoed", ok.parsed.type, "server-response");
  eq("rpcId echoed", ok.parsed.rpcId, "rpc-1");
  eq("result.ok", ok.parsed.result.ok, true);
  eq("result.value carries the snapshot", ok.parsed.result.value.rev, 1);
  check("content-type is application/json", String(ok.headers?.["content-type"]).includes("application/json"));

  // reset endpoint
  let resetCalled = 0;
  const resetRoute = createChannelRoute({
    channel: CHANNEL,
    handler: createStatusChannel({ buildSnapshot: () => ({}), resetTotals: () => { resetCalled += 1; } }),
    reject: allow,
  });
  const reset = await send(resetRoute, { url: "/llm-rate-limiter/reset", body: envelope("reset") });
  eq("POST reset -> 200", reset.status, 200);
  eq("reset invoked the callback", resetCalled, 1);

  // unknown endpoint -> 200 + failure envelope (endpoint-owned failure, not HTTP)
  const unknown = await send(route, { url: "/llm-rate-limiter/nope", body: envelope("nope") });
  eq("unknown endpoint -> 200", unknown.status, 200);
  eq("unknown endpoint ok=false", unknown.parsed.result.ok, false);
  eq("unknown endpoint code", unknown.parsed.result.error.code, "llm-rate-limiter/unknown-endpoint");

  // non-POST -> 404 (framework behaviour)
  const get = await send(route, { method: "GET", body: envelope("snapshot") });
  eq("GET -> 404", get.status, 404);
  eq("GET body", get.body, "not found");

  // wrong channel -> 404
  const wrongChannel = await send(route, { url: "/other/snapshot", body: envelope("snapshot") });
  eq("URL outside the channel -> 404", wrongChannel.status, 404);

  // channel root (no endpoint) -> 404
  const root = await send(route, { url: "/llm-rate-limiter", body: envelope("snapshot") });
  eq("channel root -> 404", root.status, 404);

  // non-JSON content type -> 415
  const wrongType = await send(route, { headers: { "content-type": "text/plain" }, body: envelope("snapshot") });
  eq("non-JSON content-type -> 415", wrongType.status, 415);

  // content-type with charset is accepted (framework splits on ';')
  const withCharset = await send(route, { headers: { "content-type": "application/json; charset=utf-8" }, body: envelope("snapshot") });
  eq("application/json; charset -> 200", withCharset.status, 200);

  // unparsable body -> 400
  const badJson = await send(route, { body: "{not json" });
  eq("unparsable body -> 400", badJson.status, 400);
  eq("unparsable body message", badJson.body, "body is not JSON");

  // valid JSON but not a client-request -> bad-request envelope
  const notEnvelope = await send(route, { body: JSON.stringify({ hello: "world", rpcId: "keep-me" }) });
  eq("non-envelope -> 200", notEnvelope.status, 200);
  eq("non-envelope ok=false", notEnvelope.parsed.result.ok, false);
  eq("non-envelope code", notEnvelope.parsed.result.error.code, "gateway/bad-request");
  eq("non-envelope echoes a string rpcId", notEnvelope.parsed.rpcId, "keep-me");

  // missing rpcId -> the framework's sentinel id
  const noId = await send(route, { body: JSON.stringify({ type: "client-request", method: "snapshot", payload: {} }) });
  eq("missing rpcId uses the sentinel", noId.parsed.rpcId, "invalid-request");

  // method != endpoint -> bad-request envelope naming both
  const mismatch = await send(route, { body: envelope("other") });
  eq("method mismatch -> 200", mismatch.status, 200);
  eq("method mismatch code", mismatch.parsed.result.error.code, "gateway/bad-request");
  check("method mismatch message names the endpoint",
    String(mismatch.parsed.result.error.message).includes("other"), mismatch.parsed.result.error.message);

  // handler throw -> 500
  const throwing = createChannelRoute({
    channel: CHANNEL,
    handler: async () => { throw new Error("boom"); },
    reject: allow,
  });
  const threw = await send(throwing, { body: envelope("snapshot") });
  eq("handler throw -> 500", threw.status, 500);
  check("handler throw message", String(threw.body).startsWith("handler failure:"), threw.body);

  // the fence is consulted first and short-circuits everything else
  let fenceCalls = 0;
  const fenced = createChannelRoute({
    channel: CHANNEL,
    handler: async () => ({ ok: true, value: {} }),
    reject: () => { fenceCalls += 1; return 403; },
  });
  const denied = await send(fenced, { body: envelope("snapshot") });
  eq("fence 403 short-circuits", denied.status, 403);
  eq("fence body", denied.body, "forbidden");
  eq("fence consulted once", fenceCalls, 1);

  const unauth = createChannelRoute({ channel: CHANNEL, handler: async () => ({}), reject: () => 401 });
  const unauthorized = await send(unauth, { body: envelope("snapshot") });
  eq("fence 401 body", unauthorized.body, "unauthorized");

  // a request without a content-type header is refused (415), like the framework
  const noContentType = await send(route, { headers: { "content-type": undefined }, body: envelope("snapshot") });
  eq("missing content-type -> 415", noContentType.status, 415);
}

/* ══ 3. the plugin falls back when rpc.handle throws the 0.1.5 error ══ */
console.log("\n[3] plugin fallback (simulated 0.1.5 regression)");
{
  /** A Cordis-shaped ctx reproducing the 0.1.5 failure mode. */
  function makeCtx({ rpcThrows = false, withWebServer = true, withConnection = true } = {}) {
    const routes = new Map();
    const effects = [];
    const logs = [];
    const scoped = new Map();

    const connection = {
      // The 0.1.5 bug: register() dereferences owner.webServer and throws.
      rpc: { handle: (channel) => {
        if (rpcThrows) throw new Error('cannot get property "webServer" without inject');
        if (routes.has(channel)) throw new Error(`already registered: ${channel}`);
        routes.set(channel, true);
        return () => routes.delete(channel);
      } },
      // The framework's public fence, which the fallback reuses.
      requestRejection: () => undefined,
    };

    const settingsScope = { get: () => ({ enabled: true, defaults: {}, models: {} }), watch: () => () => {} };

    const ctx = {
      logger: () => ({ info: (...a) => logs.push(["info", a]), warn: (...a) => logs.push(["warn", a]) }),
      settings: { register: () => settingsScope },
      get: (service) => {
        if (service === "settings") return ctx.settings;
        if (service === "connection") return withConnection ? connection : undefined;
        if (service === "webServer") return withWebServer ? webServer : undefined;
        return undefined;
      },
      inject: (deps, cb) => {
        const available = deps.every((d) =>
          (d === "settings") ||
          (d === "connection" && withConnection) ||
          (d === "webServer" && withWebServer));
        if (!available) return;
        const child = Object.create(ctx);
        child.get = (service) => (service === "webServer" && withWebServer ? webServer : ctx.get(service));
        scoped.set("__last", child);
        cb(child);
      },
      on: () => () => {},
      effect: (fn, label) => {
        const disposer = fn();
        effects.push({ label, disposer });
        return () => {};
      },
    };

    const webServer = {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    };

    return { ctx, routes, effects, logs };
  }

  // 3a. fallback mounts the route when rpc.handle throws the 0.1.5 message
  const broken = makeCtx({ rpcThrows: true });
  apply(broken.ctx);
  check("fallback mounted the channel route", broken.routes.has(CHANNEL), [...broken.routes.keys()].join(","));
  check("a warning explains the fallback",
    broken.logs.some(([level, a]) => level === "warn" && String(a[0]).includes("falling back")),
    JSON.stringify(broken.logs));
  check("a warning names the underlying error",
    broken.logs.some(([level, a]) => level === "warn" && String(a[1] ?? a[0]).includes("webServer")),
    JSON.stringify(broken.logs));
  check("an effect owns the route (fiber-scoped withdrawal)",
    broken.effects.some((e) => e.label.includes("self-registered")), JSON.stringify(broken.effects.map((e) => e.label)));

  const mounted = broken.routes.get(CHANNEL);
  eq("mounted route is a prefix route", mounted.kind, "prefix");
  eq("mounted route path", mounted.path, CHANNEL);

  // 3b. the mounted route actually serves a real round-trip
  const roundTrip = await send(mounted, { body: envelope("snapshot") });
  eq("fallback route serves snapshot -> 200", roundTrip.status, 200);
  eq("fallback snapshot ok", roundTrip.parsed.result.ok, true);
  check("fallback snapshot carries totals", "totals" in roundTrip.parsed.result.value);
  const resetTrip = await send(mounted, { url: "/llm-rate-limiter/reset", body: envelope("reset") });
  eq("fallback route serves reset -> 200", resetTrip.status, 200);
  eq("fallback reset ok", resetTrip.parsed.result.ok, true);

  // 3c. when rpc.handle works, it is preferred and no route is self-registered
  const healthy = makeCtx({ rpcThrows: false });
  apply(healthy.ctx);
  check("healthy host registers via rpc.handle", healthy.routes.has(CHANNEL));
  check("healthy host logs the preferred path",
    healthy.logs.some(([level, a]) => level === "info" && String(a[0]).includes("connection.rpc")),
    JSON.stringify(healthy.logs));
  check("healthy host does not log a fallback",
    !healthy.logs.some(([level, a]) => level === "warn" && String(a[0]).includes("falling back")));

  // 3d. no webServer -> cannot fall back; must degrade, not throw
  const noWeb = makeCtx({ rpcThrows: true, withWebServer: false });
  let threw = false;
  try { apply(noWeb.ctx); } catch { threw = true; }
  check("apply() survives rpc.handle throwing with no webServer", !threw);
  eq("nothing mounted without a web carrier", noWeb.routes.size, 0);

  // 3e. a broken fence refuses to mount rather than publishing an open route
  const badFence = makeCtx({ rpcThrows: true });
  badFence.ctx.get = ((original) => (service) => {
    const value = original(service);
    if (service === "connection") return { ...value, requestRejection: () => { throw new Error("fence exploded"); } };
    return value;
  })(badFence.ctx.get);
  apply(badFence.ctx);
  eq("an unusable fence mounts nothing", badFence.routes.size, 0);
  check("an unusable fence is reported",
    badFence.logs.some(([level, a]) => level === "warn" && String(a[0]).includes("requestRejection")),
    JSON.stringify(badFence.logs));
}

/* ══ 4. real DSH 0.1.5 package (auto-skips when absent) ═══════════════ */
console.log("\n[4] real @deepseek-ai/dsh-client-connection (optional)");
{
  const require = createRequire(import.meta.url);

  /**
   * The real package is not a dependency of this plugin (it ships with DSH),
   * so resolution tries, in order:
   *   1. a normal resolve from here (works when the plugin is a link: install
   *      and the DSH tree is an ancestor),
   *   2. $DSH_REAL_PACKAGES, an explicit escape hatch for unusual layouts,
   *   3. the profile node_modules of a `dsh plugin` install, and the global
   *      npm root that hosts the `dsh` CLI.
   * Everything is best-effort: absence downgrades to a skip, never a failure.
   */
  function resolveReal(spec) {
    const candidates = [];
    try { return require.resolve(spec); } catch { /* fall through */ }
    if (process.env.DSH_REAL_PACKAGES) candidates.push(process.env.DSH_REAL_PACKAGES);
    const home = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : undefined);
    if (home !== undefined) {
      candidates.push(`${home}\\profiles\\web\\node_modules`);
      candidates.push(`${home}\\profiles\\node_modules`);
    }
    if (process.env.APPDATA) candidates.push(`${process.env.APPDATA}\\npm\\node_modules`);
    // The global npm tree keeps DSH's own deps one level down.
    if (process.env.APPDATA) candidates.push(`${process.env.APPDATA}\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules`);
    for (const base of candidates) {
      try { return createRequire(`${base}\\__probe__.js`).resolve(spec); } catch { /* keep looking */ }
    }
    return undefined;
  }

  const connUrl = resolveReal("@deepseek-ai/dsh-client-connection");
  const cordisUrl = resolveReal("@deepseek-ai/cordis");
  if (connUrl === undefined || cordisUrl === undefined) {
    console.log("  \u25cb skipped — @deepseek-ai/dsh-client-connection is not resolvable from here");
  }

  if (connUrl !== undefined && cordisUrl !== undefined) {
    // require.resolve() hands back a native path; import() needs a file URL.
    const { pathToFileURL } = await import("node:url");
    const { Context } = await import(pathToFileURL(cordisUrl).href);
    const { HostConnectionService } = await import(pathToFileURL(connUrl).href);

    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    // connUrl points at <pkg>/lib/index.js — walk up to the package manifest.
    const version = JSON.parse(
      readFileSync(join(dirname(dirname(connUrl)), "package.json"), "utf8"),
    ).version;

    // Rebuild the real topology: webServer + credentials + settings each on
    // their own fiber, the connection service on the 0.1.5 fiber shape, and the
    // plugin applying as a sibling.
    const routes = [];
    const root = new Context();
    root.provide("credentials", {});
    root.plugin((ctx) => {
      ctx.provide("webServer", { register(route) { routes.push(route); return () => {}; } });
    });
    root.plugin((ctx) => {
      ctx.provide("settings", { register: () => ({ get: () => ({ enabled: true, defaults: {}, models: {} }), watch: () => () => {} }) });
    });
    root.plugin({ inject: ["credentials"], apply(ctx) {
      new HostConnectionService(ctx, [], { isAuthenticated: () => false });
    } });
    await new Promise((r) => setTimeout(r, 120));

    // The real service is present. Probe rpc.handle from a SIBLING plugin fiber
    // that injects only `connection` — exactly the shape the rate-limiter uses.
    // (Reading it from the root would resolve webServer through the service
    // container and mask the bug: the inject guard only applies inside a fiber
    // that declares its dependencies.)
    let rpcHandleError;
    root.plugin({ inject: ["connection"], apply(ctx) {
      try { ctx.get("connection").rpc.handle("/probe-direct", () => ({})); }
      catch (err) { rpcHandleError = err; }
    } });
    await new Promise((r) => setTimeout(r, 120));
    check(`real ${version}: connection.rpc.handle still throws the 0.1.5 error (bug present)`,
      rpcHandleError !== undefined && /webServer/.test(rpcHandleError.message),
      rpcHandleError === undefined ? "rpc.handle succeeded — DSH fixed it upstream" : rpcHandleError.message);

    // Now the plugin, on its own fiber.
    const pluginFiber = root.plugin({ inject: [], apply(ctx) { apply(ctx); } });
    await new Promise((r) => setTimeout(r, 200));

    const mounted = routes.find((r) => r.path === CHANNEL);
    check("plugin mounted the channel route against the real 0.1.5 service", mounted !== undefined,
      JSON.stringify(routes.map((r) => r.path)));
    if (mounted !== undefined) {
      eq("real mount is a prefix route", mounted.kind, "prefix");
      // The fence is the real Host/Origin + BrowserAuth pair, so it must be
      // exercised with a request that looks like a real browser call to a
      // loopback deployment:
      //   - no Host header  -> 403 (the Host fence cannot verify the authority)
      //   - loopback Host   -> 401 (Host is ours, but there is no signed cookie)
      // Proving both keeps the claim honest: we reused the framework's policy
      // rather than publishing an open endpoint.
      const noHost = await send(mounted, { body: envelope("snapshot") });
      eq("real fence refuses a request with no Host header (403)", noHost.status, 403);
      eq("real fence 403 body", noHost.body, "forbidden");

      const unauthorized = await send(mounted, {
        headers: { host: "127.0.0.1:3080" },
        body: envelope("snapshot"),
      });
      eq("real fence answers 401 for a loopback Host without a cookie", unauthorized.status, 401);
      eq("real fence 401 body", unauthorized.body, "unauthorized");
    }
    await pluginFiber?.dispose?.();
    await new Promise((r) => setTimeout(r, 60));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
