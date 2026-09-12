/**
 * End-to-end test: simulate a model configured with maxRpm=3 (via GUI),
 * fire multiple rapid requests, and verify the 4th+ request gets throttled.
 *
 * This exercises resolveModelConfig (the fixed derivation) + TokenBucketStrategy
 * exactly as the host interceptor does, minus the network call.
 *
 * Run: node test-3rpm.mjs
 */

import { TokenBucketStrategy } from "./lib/strategies/token-bucket.js";
import { SlidingWindowStrategy } from "./lib/strategies/sliding-window.js";

// Replicate the host's resolveModelConfig (must match lib/index.js)
function resolveModelConfig(cfg, key) {
  const o = cfg.models?.[key] ?? {};
  const d = cfg.defaults ?? {};
  const maxRpm = o.maxRpm ?? d.maxRpm ?? 60;
  // NEW: derive refillRate from model's maxRpm only when model overrides maxRpm
  const refillRate = o.refillRate ?? (o.maxRpm != null ? o.maxRpm / 60 : d.refillRate ?? (maxRpm / 60));
  return {
    maxConcurrent: o.maxConcurrent ?? d.maxConcurrent ?? 5,
    maxRpm,
    burstSize: o.burstSize ?? d.burstSize ?? 10,
    refillRate,
    windowMs: d.windowMs ?? 60_000,
  };
}

// ── Scenario: GUI user set ONLY maxRpm=3 for model "test/test-model" ──
const cfg = {
  enabled: true,
  strategy: "token-bucket",
  defaults: { maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 },
  models: { "test/test-model": { maxRpm: 3 } },  // only maxRpm set, like the user did
  onThrottled: "queue",
  maxQueueWaitMs: 2000,
};

const merged = resolveModelConfig(cfg, "test/test-model");
console.log("=== resolveModelConfig output (must be refillRate=0.05, maxRpm=3) ===");
console.log(JSON.stringify(merged, null, 2));

// Now build a limiter the way ensureLimiter does
const limiter = new TokenBucketStrategy(merged);

// Fire 6 rapid requests in REJECT mode (non-blocking) to see the limit bite
console.log("\n=== 6 rapid requests (reject mode, maxRpm=3, burstSize=10 default) ===");
console.log("NOTE: burstSize default is 10, so the first 10 are allowed by the bucket!");
const results = [];
for (let i = 1; i <= 6; i++) {
  const r = limiter.acquireNonBlocking();
  results.push(r.granted);
}

// Show tokens after the burst
console.log("granted sequence:", results.join(","));
console.log("remaining tokens:", limiter.getStatus().tokens);
console.log("concurrent:", limiter.getStatus().concurrent);

// The key test: burstSize matters. With burstSize=10 all 6 pass.
// To truly enforce 3 rpm, user should also set burstSize, OR we document that
// token-bucket's burst allows the first burstSize requests.
console.log("\n>>> KEY FINDING: token-bucket with default burstSize=10 allows a burst");
console.log(">>> of 10 requests even though refillRate is now 0.05 (3 rpm steady state).");

// ── Scenario B: user sets maxRpm=3 AND burstSize=3 (3-token bucket) ──
console.log("\n=== Scenario B: maxRpm=3 + burstSize=3 (bucket holds 3) ===");
const cfgB = {
  enabled: true,
  strategy: "token-bucket",
  defaults: { maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 },
  models: { "test/test-model": { maxRpm: 3, burstSize: 3 } },
  onThrottled: "reject",
  maxQueueWaitMs: 2000,
};
const mergedB = resolveModelConfig(cfgB, "test/test-model");
const limiterB = new TokenBucketStrategy(mergedB);
const resB = [];
for (let i = 1; i <= 6; i++) {
  resB.push(limiterB.acquireNonBlocking().granted);
  limiterB.releaseSlot();  // reject mode: slot released immediately after fake call
}
console.log("granted sequence (7th request moment):", resB.join(","));
console.log("expected: true,true,true,false,false,false — the 4th+ rejected!");

// ── Scenario C: queue mode with maxRpm=3, burstSize=3 — 4th request waits ──
console.log("\n=== Scenario C: queue mode, 6 rapid requests, bucket=3 ===");
const cfgC = {
  enabled: true,
  strategy: "token-bucket",
  defaults: { maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 },
  models: { "test/test-model": { maxRpm: 3, burstSize: 3 } },
  onThrottled: "queue",
  maxQueueWaitMs: 1000,
};
const mergedC = resolveModelConfig(cfgC, "test/test-model");
const limiterC = new TokenBucketStrategy(mergedC);
const started = Date.now();
const permits = await Promise.all(
  Array.from({ length: 6 }, () => limiterC.acquire({ timeoutMs: 1000 }))
);
console.log("granted:", permits.map((p) => p.granted).join(","));
console.log("waits(ms):", permits.map((p) => p.waitMs).join(","));
const forbidden = permits.filter((p) => !p.granted).length;
console.log(`blocked: ${forbidden}/6 (expect >=3 blocked when bucket empty)`);
console.log(`elapsed: ${Date.now() - started}ms`);

// Cleanup
limiter.dispose();
limiterB.dispose();
limiterC.dispose();

// ── Summary ──
console.log("\n=== 结论 ===");
console.log("1. maxRpm 现在会被正确转换为 refillRate (maxRpm/60)");
console.log("2. 但 token-bucket 的 burstSize 默认=10, 所以前 10 个请求仍会突发放行");
console.log("3. 想要严格 3rpm: 需要同时设置 burstSize=3 (桶容量=3)");
console.log("4. 或者改用 sliding-window 策略, maxRpm 直接生效, 无需 burstSize");