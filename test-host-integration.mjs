/**
 * Host-side integration test for the v0.2.0 status channel.
 *
 * Unlike test-status-rpc.mjs (which drives the handler in isolation), this
 * boots the REAL plugin `apply()` against a fake Cordis-like context that
 * records what the plugin registers, then exercises the registered channel
 * handler end-to-end: interception of `llm/stream` → counters → snapshot.
 *
 * It proves the wiring between lib/index.js and lib/status-rpc.js — the part a
 * unit test of either half cannot see: that the same numbers the interceptor
 * increments are the numbers the channel serves.
 *
 * Run: node test-host-integration.mjs
 */
import { apply, name, SETTINGS_NS } from "./lib/index.js";
import { CHANNEL } from "./lib/status-rpc.js";

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  \u2713 ${label}`); }
  else { failed += 1; console.log(`  \u2717 ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
}
function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ── a Cordis-shaped context that records registrations ─────────────── */
function makeContext({ withSettings = true, withConnection = true, config } = {}) {
  const waterfallListeners = [];
  const effects = [];
  const channels = new Map();
  const services = new Map();
  const logs = [];

  const cfgValue = config ?? {
    enabled: true,
    strategy: "token-bucket",
    onThrottled: "queue",
    maxQueueWaitMs: 5000,
    defaults: { maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 },
    models: {},
  };

  const settingsScope = {
    get: () => cfgValue,
    watch: (fn) => { settingsScope.listener = fn; return () => { settingsScope.listener = undefined; }; },
  };

  const ctx = {
    logger: () => ({
      info: (...a) => logs.push(["info", a]),
      warn: (...a) => logs.push(["warn", a]),
    }),
    // Real Cordis exposes injected services as properties on the scoped context
    // (`scopedCtx.settings`, `scopedCtx.get("connection")`). The plugin uses
    // both forms, so the mock must offer both.
    settings: withSettings ? { register: () => settingsScope } : undefined,
    // The plugin calls ctx.inject(deps, cb): run cb when every dep is present.
    inject: (deps, cb) => {
      const available = deps.every((d) =>
        (d === "settings" && withSettings) || (d === "connection" && withConnection));
      if (!available) return;
      services.set("__injected", true);
      cb(ctx);
    },
    get: (service) => {
      if (service === "settings") return withSettings ? ctx.settings : undefined;
      if (service === "connection") {
        if (!withConnection) return undefined;
        return { rpc: { handle: (channel, handler) => {
          if (channels.has(channel)) throw new Error(`channel already registered: ${channel}`);
          channels.set(channel, handler);
          return () => channels.delete(channel); // the fiber disposer
        } } };
      }
      return undefined;
    },
    on: (event, listener) => {
      if (event !== "llm/stream") throw new Error(`unexpected event: ${event}`);
      waterfallListeners.push(listener);
      return () => {
        const i = waterfallListeners.indexOf(listener);
        if (i >= 0) waterfallListeners.splice(i, 1);
      };
    },
    effect: (fn, label) => {
      const disposer = fn();
      effects.push({ label, disposer });
      return () => {};
    },
  };

  return {
    ctx, cfgValue, channels, waterfallListeners, effects, logs,
    /** Run every registered effect disposer (mirrors host shutdown). */
    dispose: () => {
      for (const { disposer } of effects) {
        if (typeof disposer === "function") { try { disposer(); } catch { /* ignore */ } }
      }
      effects.length = 0;
    },
    /** Drive the interceptor: `next` yields the given chunks. */
    run: async (options, chunks = [{ type: "text", text: "hi" }], signalOverride) => {
      const listener = waterfallListeners[0];
      const signal = signalOverride ?? options.signal;
      const next = async function* () { for (const c of chunks) yield c; };
      const out = [];
      for await (const chunk of listener({ ...options, signal }, next)) out.push(chunk);
      return out;
    },
  };
}

/**
 * Track every context so the process can shut them all down at the end —
 * the strategies hold refill intervals, and a leaked timer would keep Node
 * alive forever after the assertions have finished.
 */
const liveContexts = [];
function boot(options) {
  const h = makeContext(options);
  apply(h.ctx);
  liveContexts.push(h);
  return h;
}

/* ══ 1. registration ═════════════════════════════════════════════════ */
console.log("\n[1] plugin registration");
eq("plugin name unchanged", name, "llm-rate-limiter");
eq("settings namespace unchanged", SETTINGS_NS, "llm-rate-limiter");
eq("channel constant", CHANNEL, "/llm-rate-limiter");

const h = boot();
check("llm/stream interceptor registered", h.waterfallListeners.length === 1);
check("status channel registered", h.channels.has(CHANNEL), [...h.channels.keys()].join(","));
check("channel handler is callable", typeof h.channels.get(CHANNEL) === "function");
check("an effect was registered (fiber-owned cleanup)",
  h.effects.some((e) => e.label.includes("status rpc channel")), JSON.stringify(h.effects.map((e) => e.label)));
check("teardown effect registered", h.effects.some((e) => e.label.includes("dispose llm/stream")));

const handler = h.channels.get(CHANNEL);

/* ══ 2. snapshot before any traffic ══════════════════════════════════ */
console.log("\n[2] snapshot — idle");
{
  const r = await handler("snapshot", {});
  eq("snapshot ok", r.ok, true);
  eq("requests start at 0", r.value.totals.requests, 0);
  eq("granted starts at 0", r.value.totals.granted, 0);
  eq("events start empty", r.value.events.length, 0);
  eq("rev starts at 0", r.value.rev, 0);
  eq("enabled reflects config", r.value.enabled, true);
  eq("strategy reflected", r.value.strategy, "token-bucket");
  eq("onThrottled reflected", r.value.onThrottled, "queue");
  eq("no models observed yet", Object.keys(r.value.models).length, 0);
}

/* ══ 3. a passing call is counted and observable ═════════════════════ */
console.log("\n[3] instrumentation — passing call");
{
  const out = await h.run({ provider: "deepseek", model: "deepseek-chat" });
  check("interceptor forwarded the stream", out.length === 1 && out[0].text === "hi");

  const r = await handler("snapshot", {});
  eq("requests counted", r.value.totals.requests, 1);
  eq("granted counted", r.value.totals.granted, 1);
  eq("no rejections", r.value.totals.rejected, 0);
  check("model row present", "deepseek/deepseek-chat" in r.value.models);
  const m = r.value.models["deepseek/deepseek-chat"];
  eq("model strategy reported", m.strategy, "token-bucket");
  eq("token consumed (9 of 10 left)", m.tokens, 9);
  eq("burst size reported", m.burstSize, 10);
  eq("slot released after the call", m.concurrent, 0);
  eq("maxConcurrent reported", m.maxConcurrent, 5);
  check("granted event recorded", r.value.events.some((e) => e.event === "granted" && e.model === "deepseek/deepseek-chat"));
  check("completed event recorded", r.value.events.some((e) => e.event === "completed"));
  check("rev advanced", r.value.rev > 0, String(r.value.rev));
  check("every event carries ts", r.value.events.every((e) => typeof e.ts === "number"));
}

/* ══ 4. reject mode counts rejections ════════════════════════════════ */
console.log("\n[4] instrumentation — reject mode");
{
  const r = boot({ config: {
    enabled: true, strategy: "token-bucket", onThrottled: "reject", maxQueueWaitMs: 1000,
    defaults: { maxConcurrent: 1, maxRpm: 60, burstSize: 1, refillRate: 0.0001 },
    models: {},
  } });
  const rh = r.channels.get(CHANNEL);

  // First call consumes the single token and (in reject mode) the single slot.
  const first = await r.run({ provider: "p", model: "m" });
  check("first call passes", !first.some((c) => c.reason?.failure?.code === "RATE_LIMIT"));

  // Second call has no token left → rejected immediately.
  const second = await r.run({ provider: "p", model: "m" });
  const rejected = second.find((c) => c.reason?.failure?.code === "RATE_LIMIT");
  check("second call rejected with RATE_LIMIT", rejected !== undefined, JSON.stringify(second));
  eq("reject terminal kind is error", rejected?.reason?.kind, "error");

  const snap = await rh("snapshot", {});
  eq("requests counted", snap.value.totals.requests, 2);
  eq("granted counted", snap.value.totals.granted, 1);
  eq("rejected counted", snap.value.totals.rejected, 1);
  check("rejected event recorded", snap.value.events.some((e) => e.event === "rejected"));
}

/* ══ 5. abort while queued counts as aborted ═════════════════════════ */
console.log("\n[5] instrumentation — abort while queued");
{
  const a = boot({ config: {
    enabled: true, strategy: "token-bucket", onThrottled: "queue", maxQueueWaitMs: 30_000,
    defaults: { maxConcurrent: 1, maxRpm: 60, burstSize: 1, refillRate: 0.0001 },
    models: {},
  } });
  const ah = a.channels.get(CHANNEL);

  // Occupy the only concurrent slot with a call that never finishes.
  const slowSignal = new AbortController();
  const slow = a.run({ provider: "p", model: "m", signal: slowSignal.signal }, [{ type: "text", text: "x" }]);

  // Park a second call behind it, then abort it while it waits.
  const abort = new AbortController();
  const parked = a.run({ provider: "p", model: "m" }, [{ type: "text", text: "y" }], abort.signal);
  await new Promise((res) => setTimeout(res, 30));
  abort.abort();

  const parkedOut = await parked;
  const abortedChunk = parkedOut.find((c) => c.reason?.kind === "aborted");
  check("queued call finished aborted", abortedChunk !== undefined, JSON.stringify(parkedOut));

  await slow; // let the first call finish so the snapshot is stable
  const snap = await ah("snapshot", {});
  check("aborted counted", snap.value.totals.aborted >= 1, JSON.stringify(snap.value.totals));
  check("aborted event recorded", snap.value.events.some((e) => e.event === "aborted"));
}

/* ══ 6. disabled config bypasses instrumentation ═════════════════════ */
console.log("\n[6] disabled bypass");
{
  const d = boot({ config: {
    enabled: false, strategy: "token-bucket", onThrottled: "queue", maxQueueWaitMs: 1000,
    defaults: { maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 }, models: {},
  } });
  const dh = d.channels.get(CHANNEL);
  await d.run({ provider: "p", model: "m" });
  const snap = await dh("snapshot", {});
  eq("no requests counted while disabled", snap.value.totals.requests, 0);
  eq("enabled=false surfaced to the panel", snap.value.enabled, false);
  eq("no models registered while disabled", Object.keys(snap.value.models).length, 0);
}

/* ══ 7. per-model opt-out bypasses instrumentation ═══════════════════ */
console.log("\n[7] per-model opt-out");
{
  const o = boot({ config: {
    enabled: true, strategy: "token-bucket", onThrottled: "queue", maxQueueWaitMs: 1000,
    defaults: { maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 },
    models: { "skipper/model": { enabled: false } },
  } });
  const oh = o.channels.get(CHANNEL);
  await o.run({ provider: "skipper", model: "model" });
  const snap = await oh("snapshot", {});
  eq("opted-out model not counted", snap.value.totals.requests, 0);
  eq("opted-out model not in the snapshot", Object.keys(snap.value.models).length, 0);
}

/* ══ 8. reset over the channel ═══════════════════════════════════════ */
console.log("\n[8] reset");
{
  const r = boot();
  const rh = r.channels.get(CHANNEL);

  await r.run({ provider: "p", model: "m" });
  await r.run({ provider: "p", model: "m" });
  const before = await rh("snapshot", {});
  eq("two requests before reset", before.value.totals.requests, 2);

  const resetResult = await rh("reset", {});
  eq("reset ok", resetResult.ok, true);
  const after = await rh("snapshot", {});
  eq("requests zeroed", after.value.totals.requests, 0);
  eq("granted zeroed", after.value.totals.granted, 0);
  eq("events cleared", after.value.events.length, 0);
  check("rev still advanced (client highlight cursor keeps moving)",
    after.value.rev > before.value.rev, `${before.value.rev} -> ${after.value.rev}`);
  // A limiter that was already created stays in the map, so its live status is
  // still reported after a reset — only the counters are statistics.
  check("limiter state survives a reset", "p/m" in after.value.models);
}

/* ══ 9. unknown endpoint over the real channel ═══════════════════════ */
console.log("\n[9] unknown endpoint");
{
  const r = boot();
  const rh = r.channels.get(CHANNEL);
  const res = await rh("does-not-exist", {});
  eq("unknown endpoint ok=false", res.ok, false);
  eq("unknown endpoint code", res.error.code, "llm-rate-limiter/unknown-endpoint");
}

/* ══ 10. absent services degrade silently ════════════════════════════ */
console.log("\n[10] absent services");
{
  const noConn = makeContext({ withConnection: false });
  let threw = false;
  try { apply(noConn.ctx); } catch { threw = true; }
  liveContexts.push(noConn);
  check("apply() survives a host without connection", !threw);
  eq("no channel registered", noConn.channels.size, 0);
  eq("interceptor still registered (rate limiting works)", noConn.waterfallListeners.length, 1);
  await noConn.run({ provider: "p", model: "m" });
  check("rate limiting still functions without a channel", noConn.waterfallListeners.length === 1);

  const noSettings = makeContext({ withSettings: false });
  threw = false;
  try { apply(noSettings.ctx); } catch { threw = true; }
  liveContexts.push(noSettings);
  check("apply() survives a host without settings", !threw);
  check("channel still registered without settings", noSettings.channels.has(CHANNEL));

  const neither = makeContext({ withSettings: false, withConnection: false });
  threw = false;
  try { apply(neither.ctx); } catch { threw = true; }
  liveContexts.push(neither);
  check("apply() survives a host with neither service", !threw);
  eq("nothing registered when neither service exists", neither.channels.size, 0);
  eq("interceptor still registered", neither.waterfallListeners.length, 1);
}

/* ══ 11. snapshot is JSON-safe with real strategy output ═════════════ */
console.log("\n[11] JSON safety with real strategies");
{
  for (const strategy of ["token-bucket", "sliding-window"]) {
    const r = boot({ config: {
      enabled: true, strategy, onThrottled: "queue", maxQueueWaitMs: 1000,
      defaults: { maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 }, models: {},
    } });
    const rh = r.channels.get(CHANNEL);
    await r.run({ provider: "prov", model: `m-${strategy}` });
    const snap = await rh("snapshot", {});
    let roundTrip;
    try { roundTrip = JSON.parse(JSON.stringify(snap)); check(`${strategy}: snapshot round-trips`, true); }
    catch (err) { check(`${strategy}: snapshot round-trips`, false, err.message); continue; }
    const bad = (function scan(v) {
      if (typeof v === "function" || v === undefined) return true;
      if (v !== null && typeof v === "object") return Object.values(v).some(scan);
      return false;
    })(roundTrip);
    check(`${strategy}: no functions/undefined in the payload`, !bad);
    const m = roundTrip.value.models[`prov/m-${strategy}`];
    check(`${strategy}: strategy field correct`, m?.strategy === strategy, JSON.stringify(m));
    check(`${strategy}: concurrency fields present`,
      typeof m?.concurrent === "number" && typeof m?.maxConcurrent === "number");
    check(`${strategy}: queued field present`, typeof m?.queued === "number");
  }
}

/* ══ 12. many models stay bounded ════════════════════════════════════ */
console.log("\n[12] bounded payload");
{
  const r = boot();
  const rh = r.channels.get(CHANNEL);
  for (let i = 0; i < 20; i += 1) await r.run({ provider: "p", model: `m${i}` });
  const snap = await rh("snapshot", {});
  eq("all 20 models reported", Object.keys(snap.value.models).length, 20);
  check("events capped at 8 despite 40 events", snap.value.events.length === 8, String(snap.value.events.length));
  const bytes = Buffer.byteLength(JSON.stringify(snap));
  check("snapshot stays small (< 6 KB)", bytes < 6144, `${bytes} bytes`);
}

/* ── shutdown: run every effect disposer so no strategy timer keeps Node alive ── */
for (const h of liveContexts) h.dispose();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
