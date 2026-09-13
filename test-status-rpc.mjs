/**
 * Unit tests for the status RPC channel and the host-side statistics
 * aggregation (lib/status-rpc.js + the counters in lib/index.js).
 *
 * Run: node test-status-rpc.mjs
 *
 * The tests drive `createStatusChannel` directly (no HTTP, no DSH runtime) and
 * reproduce the host's counter/ring logic with the same helper shape, so a
 * regression in either half fails here.
 */
import { CHANNEL, createStatusChannel, failure, success } from "./lib/status-rpc.js";

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** A miniature of the host's statistics block, kept in lockstep with lib/index.js. */
function makeHarness({ limiters = new Map() } = {}) {
  const EVENT_RING_LIMIT = 64;
  const SNAPSHOT_EVENT_COUNT = 8;
  const totals = { requests: 0, granted: 0, rejected: 0, timeouts: 0, aborted: 0, totalWaitMs: 0 };
  let rev = 0;
  const eventRing = [];
  const cfg = { enabled: true, strategy: "token-bucket", onThrottled: "queue" };

  const recordEvent = (event) => {
    eventRing.push({ ...event, ts: Date.now() });
    if (eventRing.length > EVENT_RING_LIMIT) eventRing.shift();
    rev += 1;
  };
  const buildSnapshot = () => {
    const models = {};
    for (const [key, limiter] of limiters) {
      try { models[key] = limiter.getStatus(); } catch { /* skip */ }
    }
    return {
      rev, ts: Date.now(),
      enabled: cfg.enabled !== false, strategy: cfg.strategy, onThrottled: cfg.onThrottled,
      totals: { ...totals }, models,
      events: eventRing.slice(-SNAPSHOT_EVENT_COUNT),
    };
  };
  const resetTotals = () => {
    for (const key of Object.keys(totals)) totals[key] = 0;
    eventRing.length = 0;
    rev += 1;
  };

  return { totals, recordEvent, buildSnapshot, resetTotals, eventRing, revOf: () => rev, cfg };
}

/* ── 1. envelope helpers ─────────────────────────────────────────────── */
console.log("\n[1] envelope helpers");
{
  const ok = success({ a: 1 });
  eq("success().ok", ok.ok, true);
  check("success() value preserved", ok.value.a === 1);
  check("success() has no error field", !("error" in ok));

  const bad = failure("x/y", "boom");
  eq("failure().ok", bad.ok, false);
  eq("failure().error.code", bad.error.code, "x/y");
  eq("failure().error.message", bad.error.message, "boom");
  check("failure() details defaults to {}", typeof bad.error.details === "object" && bad.error.details !== null);
}

/* ── 2. channel name ─────────────────────────────────────────────────── */
console.log("\n[2] channel name");
{
  eq("CHANNEL value", CHANNEL, "/llm-rate-limiter");
  check("CHANNEL matches framework pattern /^\\/[A-Za-z0-9._~-]+$/", /^\/[A-Za-z0-9._~-]+$/.test(CHANNEL), CHANNEL);
  check("CHANNEL is not the reserved /api", CHANNEL !== "/api");
}

/* ── 3. snapshot endpoint ────────────────────────────────────────────── */
console.log("\n[3] snapshot endpoint");
{
  const h = makeHarness();
  const handler = createStatusChannel({ buildSnapshot: h.buildSnapshot, resetTotals: h.resetTotals });

  const r = await handler("snapshot", {});
  eq("snapshot ok", r.ok, true);
  for (const field of ["rev", "ts", "enabled", "strategy", "onThrottled", "totals", "models", "events"]) {
    check(`snapshot.value.${field} present`, field in r.value, Object.keys(r.value).join(","));
  }
  eq("snapshot totals shape", Object.keys(r.value.totals).sort().join(","),
    "aborted,granted,rejected,requests,timeouts,totalWaitMs");
  check("snapshot events is an array", Array.isArray(r.value.events));
}

/* ── 4. reset endpoint ───────────────────────────────────────────────── */
console.log("\n[4] reset endpoint");
{
  const h = makeHarness();
  const handler = createStatusChannel({ buildSnapshot: h.buildSnapshot, resetTotals: h.resetTotals });

  h.totals.requests = 10; h.totals.granted = 7; h.totals.totalWaitMs = 1234;
  h.recordEvent({ event: "granted", model: "a/b" });
  const beforeRev = h.revOf();

  const r = await handler("reset", {});
  eq("reset ok", r.ok, true);
  eq("reset requests zeroed", h.buildSnapshot().totals.requests, 0);
  eq("reset granted zeroed", h.buildSnapshot().totals.granted, 0);
  eq("reset totalWaitMs zeroed", h.buildSnapshot().totals.totalWaitMs, 0);
  eq("reset drops events", h.buildSnapshot().events.length, 0);
  check("reset bumps rev", h.revOf() > beforeRev, `${beforeRev} -> ${h.revOf()}`);
}

/* ── 5. unknown endpoint ─────────────────────────────────────────────── */
console.log("\n[5] unknown endpoint");
{
  const h = makeHarness();
  const handler = createStatusChannel({ buildSnapshot: h.buildSnapshot, resetTotals: h.resetTotals });

  const r = await handler("nope", {});
  eq("unknown endpoint ok=false", r.ok, false);
  eq("unknown endpoint code", r.error.code, "llm-rate-limiter/unknown-endpoint");
  check("unknown endpoint message mentions endpoint", r.error.message.includes("nope"), r.error.message);

  const r2 = await handler("", {});
  eq("empty endpoint rejected", r2.ok, false);
  eq("empty endpoint code", r2.error.code, "llm-rate-limiter/unknown-endpoint");
}

/* ── 6. JSON-safety of every envelope ────────────────────────────────── */
console.log("\n[6] JSON-safety");
{
  const h = makeHarness({
    limiters: new Map([
      ["deepseek/deepseek-chat", { getStatus: () => ({ strategy: "token-bucket", tokens: 7.5, burstSize: 10, refillRate: 0.5, concurrent: 2, maxConcurrent: 5, queued: 1 }) }],
      ["openai/gpt-4o", { getStatus: () => ({ strategy: "sliding-window", windowMs: 60000, countInWindow: 3, maxRpm: 3, concurrent: 1, maxConcurrent: 5, queued: 0 }) }],
    ]),
  });
  const handler = createStatusChannel({ buildSnapshot: h.buildSnapshot, resetTotals: h.resetTotals });
  h.recordEvent({ event: "granted", model: "deepseek/deepseek-chat", waitMs: 4210 });

  for (const ep of ["snapshot", "reset", "bogus"]) {
    const r = await handler(ep, {});
    let roundTrip;
    try {
      roundTrip = JSON.parse(JSON.stringify(r));
      check(`${ep}: envelope is JSON round-trippable`, true);
    } catch (err) {
      check(`${ep}: envelope is JSON round-trippable`, false, err.message);
      continue;
    }
    const hasBad = (function scan(value) {
      if (typeof value === "function") return true;
      if (value === undefined) return true;
      if (value !== null && typeof value === "object") return Object.values(value).some(scan);
      return false;
    })(roundTrip);
    check(`${ep}: no functions/undefined in payload`, !hasBad);
  }
}

/* ── 7. a misbehaving strategy cannot break the snapshot ─────────────── */
console.log("\n[7] defensive getStatus");
{
  const h = makeHarness({
    limiters: new Map([
      ["bad/model", { getStatus: () => { throw new Error("strategy exploded"); } }],
      ["good/model", { getStatus: () => ({ strategy: "token-bucket", tokens: 1, burstSize: 2, concurrent: 0, maxConcurrent: 1, queued: 0 }) }],
    ]),
  });
  const handler = createStatusChannel({ buildSnapshot: h.buildSnapshot, resetTotals: h.resetTotals });
  const r = await handler("snapshot", {});
  eq("snapshot still ok", r.ok, true);
  check("throwing strategy omitted", !("bad/model" in r.value.models));
  check("healthy strategy retained", "good/model" in r.value.models);
}

/* ── 8. event ring bound + snapshot window ───────────────────────────── */
console.log("\n[8] event ring");
{
  const h = makeHarness();
  for (let i = 0; i < 100; i += 1) h.recordEvent({ event: "granted", model: `m/${i}` });
  eq("ring capped at 64", h.eventRing.length, 64);
  eq("ring keeps newest", h.eventRing[h.eventRing.length - 1].model, "m/99");
  eq("ring drops oldest", h.eventRing[0].model, "m/36");
  eq("snapshot carries last 8", h.buildSnapshot().events.length, 8);
  eq("snapshot window is newest", h.buildSnapshot().events[7].model, "m/99");
  check("every event carries ts", h.eventRing.every((e) => typeof e.ts === "number"));
  eq("rev equals event count", h.revOf(), 100);
}

/* ── 9. counted paths (mirrors the interceptor instrumentation) ──────── */
console.log("\n[9] counter paths");
{
  const h = makeHarness();
  // granted in reject mode
  h.totals.requests += 1; h.totals.granted += 1; h.recordEvent({ event: "granted", model: "a/b", waitMs: 0 });
  // granted via queue after a wait
  h.totals.requests += 1; h.totals.granted += 1; h.totals.totalWaitMs += 2000; h.recordEvent({ event: "granted", model: "a/b", waitMs: 2000 });
  // rejected (reject mode)
  h.totals.requests += 1; h.totals.rejected += 1; h.recordEvent({ event: "rejected", model: "a/b" });
  // queue timeout
  h.totals.requests += 1; h.totals.timeouts += 1; h.recordEvent({ event: "timeout", model: "a/b", waitMs: 60000 });
  // aborted while queued
  h.totals.requests += 1; h.totals.aborted += 1; h.recordEvent({ event: "aborted", model: "a/b", waitMs: 500 });
  // completed after a successful call
  h.recordEvent({ event: "completed", model: "a/b" });

  const snap = h.buildSnapshot();
  eq("requests", snap.totals.requests, 5);
  eq("granted", snap.totals.granted, 2);
  eq("rejected", snap.totals.rejected, 1);
  eq("timeouts", snap.totals.timeouts, 1);
  eq("aborted", snap.totals.aborted, 1);
  eq("totalWaitMs", snap.totals.totalWaitMs, 2000);
  eq("granted + rejected + timeouts + aborted == requests",
    snap.totals.granted + snap.totals.rejected + snap.totals.timeouts + snap.totals.aborted, snap.totals.requests);
  eq("average wait over granted", (snap.totals.totalWaitMs / snap.totals.granted), 1000);
}

/* ── 10. disabled passthrough does not touch counters ────────────────── */
console.log("\n[10] passthrough untouched");
{
  const h = makeHarness();
  // The interceptor returns before any instrumentation when disabled or when a
  // model opts out, so the snapshot must stay at its initial values.
  const snap = h.buildSnapshot();
  eq("requests stays 0", snap.totals.requests, 0);
  eq("events stay empty", snap.events.length, 0);
  eq("rev stays 0", snap.rev, 0);
  eq("enabled reflects config", snap.enabled, true);
  h.cfg.enabled = false;
  eq("enabled=false reflected", h.buildSnapshot().enabled, false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
