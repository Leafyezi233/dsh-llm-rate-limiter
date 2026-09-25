/**
 * Live HTTP verification for the self-registered status route (Option E).
 *
 * Run: node tools/verify-live-route.mjs
 *
 * The other suites drive the route handler directly. This one goes through the
 * REAL stack end-to-end:
 *
 *   real @deepseek-ai/dsh-host-webserver  (an actual HTTP listener on a real socket)
 *   + real @deepseek-ai/dsh-client-connection (the 0.1.5-rc.3 package whose
 *     rpc.handle is broken by its own inject list)
 *   + the real plugin apply()
 *
 * and then issues real HTTP requests over the loopback socket. It is the only
 * check that can distinguish "the route is absent" (405 from the fallback) from
 * "the route exists and is fenced" (401), which is exactly how the DSH 0.1.5
 * regression presented itself.
 *
 * Requires a resolvable DSH install; exits 2 (skipped) when there is none, so it
 * is safe to invoke from anywhere.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { apply as pluginApply } from "../lib/index.js";
import { CHANNEL } from "../lib/status-rpc.js";

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  \u2713 ${label}`); }
  else { failed += 1; console.log(`  \u2717 ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
}
function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const require = createRequire(import.meta.url);
function resolveReal(spec) {
  try { return require.resolve(spec); } catch { /* fall through */ }
  const bases = [];
  if (process.env.DSH_REAL_PACKAGES) bases.push(process.env.DSH_REAL_PACKAGES);
  const home = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : undefined);
  if (home !== undefined) {
    bases.push(`${home}\\profiles\\web\\node_modules`);
    bases.push(`${home}\\profiles\\node_modules`);
  }
  if (process.env.APPDATA) {
    bases.push(`${process.env.APPDATA}\\npm\\node_modules`);
    bases.push(`${process.env.APPDATA}\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules`);
  }
  for (const base of bases) {
    try { return createRequire(`${base}\\__probe__.js`).resolve(spec); } catch { /* keep looking */ }
  }
  return undefined;
}

const cordisPath = resolveReal("@deepseek-ai/cordis");
const connPath = resolveReal("@deepseek-ai/dsh-client-connection");
const wsPath = resolveReal("@deepseek-ai/dsh-host-webserver");

if (cordisPath === undefined || connPath === undefined || wsPath === undefined) {
  console.log("skipped — a DSH install is not resolvable from here");
  process.exit(2);
}

const { Context, Service } = await import(pathToFileURL(cordisPath).href);
const { HostConnectionService } = await import(pathToFileURL(connPath).href);
const { WebServer } = await import(pathToFileURL(wsPath).href);

const versionOf = (p) => JSON.parse(readFileSync(join(dirname(dirname(p)), "package.json"), "utf8")).version;
console.log(`\nDSH packages under test: client-connection ${versionOf(connPath)}, host-webserver ${versionOf(wsPath)}`);

/** A 32-byte base64url secret, the shape BrowserAuth.canonicalSecret() accepts. */
const SECRET = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");

/**
 * Boot the real stack on an ephemeral loopback port.
 * @param {boolean} authenticated - what the real BrowserAuth fence should decide.
 * @returns {Promise<{ base: string, close: () => Promise<void> }>}
 */
async function boot(authenticated) {
  const root = new Context();

  // credentials: BrowserAuth reads its signing secret through modifyRecord().
  root.provide("credentials", {
    async modifyRecord() { return { kind: "grant", payload: { version: 1, secret: SECRET } }; },
  });

  // settings: the plugin registers its namespace here.
  root.provide("settings", {
    register: () => ({ get: () => ({ enabled: true, defaults: {}, models: {} }), watch: () => () => {} }),
  });

  // A real HTTP listener on an OS-assigned port.
  let server;
  root.plugin({ inject: [], apply: async (ctx) => {
    server = new WebServer(ctx, { host: "127.0.0.1", port: 0, compression: "none", compressionLevel: 1, compressionThresholdBytes: 1024 });
    await server[Service.init]();
  } });

  // The connection service on the REAL 0.1.5 fiber shape (inject: credentials).
  root.plugin({ inject: ["credentials"], apply: (ctx) => {
    new HostConnectionService(ctx, [], { isAuthenticated: () => authenticated });
  } });

  await new Promise((r) => setTimeout(r, 200));

  // The plugin under test.
  const fiber = root.plugin({ inject: [], apply: (ctx) => pluginApply(ctx) });
  await new Promise((r) => setTimeout(r, 300));

  return {
    base: `http://127.0.0.1:${server.port}`,
    async close() {
      await fiber?.dispose?.();
      await root.stop?.();
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}

/** One real HTTP round trip. Returns { status, body }. */
async function post(base, path, payload) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, body: text, json };
}

const clientRequest = (method) => ({ type: "client-request", rpcId: "live-1", method, payload: {} });

/* ══ 1. the route exists and the framework fence protects it ═══════════ */
console.log("\n[1] real HTTP — route present, fence enforced");
{
  const live = await boot(false); // unauthenticated browser
  try {
    // Before the fix this answered 405 (the fallback had no route to match).
    const denied = await post(live.base, `${CHANNEL}/snapshot`, clientRequest("snapshot"));
    check("POST /llm-rate-limiter/snapshot is no longer 405 (route exists)", denied.status !== 405, `status ${denied.status}`);
    eq("unauthenticated request is refused with 401", denied.status, 401);
    eq("401 body comes from the framework fence", denied.body, "unauthorized");

    // A path outside the channel still 404s — the prefix route is not a catch-all.
    const outside = await post(live.base, "/definitely-not-ours/x", clientRequest("x"));
    eq("a path outside the channel still 404s", outside.status, 404);
  } finally {
    await live.close();
  }
}

/* ══ 2. a full round trip over a real socket ══════════════════════════ */
console.log("\n[2] real HTTP — authenticated round trip");
{
  const live = await boot(true); // fence accepts
  try {
    const snap = await post(live.base, `${CHANNEL}/snapshot`, clientRequest("snapshot"));
    eq("authenticated snapshot -> 200", snap.status, 200);
    eq("wire envelope type", snap.json?.type, "server-response");
    eq("wire rpcId echoed", snap.json?.rpcId, "live-1");
    eq("result.ok", snap.json?.result?.ok, true);
    check("snapshot carries totals", snap.json?.result?.value?.totals !== undefined);
    check("snapshot carries models", snap.json?.result?.value?.models !== undefined);
    check("snapshot carries events", Array.isArray(snap.json?.result?.value?.events));

    const reset = await post(live.base, `${CHANNEL}/reset`, clientRequest("reset"));
    eq("authenticated reset -> 200", reset.status, 200);
    eq("reset result.ok", reset.json?.result?.ok, true);

    const unknown = await post(live.base, `${CHANNEL}/nope`, clientRequest("nope"));
    eq("unknown endpoint -> 200 with a failure envelope", unknown.status, 200);
    eq("unknown endpoint ok=false", unknown.json?.result?.ok, false);
    eq("unknown endpoint code", unknown.json?.result?.error?.code, "llm-rate-limiter/unknown-endpoint");

    // The protocol rules the framework enforces must hold here too.
    const mismatch = await post(live.base, `${CHANNEL}/snapshot`, clientRequest("other"));
    eq("method/endpoint mismatch -> gateway/bad-request", mismatch.json?.result?.error?.code, "gateway/bad-request");

    const wrongType = await fetch(`${live.base}${CHANNEL}/snapshot`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: "hi",
    });
    eq("non-JSON content-type -> 415", wrongType.status, 415);
    await wrongType.text();

    const getReq = await fetch(`${live.base}${CHANNEL}/snapshot`, { method: "GET" });
    eq("GET -> 404 (POST only)", getReq.status, 404);
    await getReq.text();
  } finally {
    await live.close();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
