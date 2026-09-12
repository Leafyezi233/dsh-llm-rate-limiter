/**
 * Smoke test for rate limiter strategies.
 * Run:  node test-strategies.mjs
 */

import { TokenBucketStrategy } from "./lib/strategies/token-bucket.js";
import { SlidingWindowStrategy } from "./lib/strategies/sliding-window.js";
import { setTimeout as sleep } from "node:timers/promises";

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ FAIL: ${label}`); }
}

/* ── Token Bucket ─────────────────────────────────────── */
console.log("TokenBucketStrategy");
{
  const tb = new TokenBucketStrategy({ burstSize: 3, refillRate: 10, maxConcurrent: 2 });

  // 1. Fast-path: first 3 requests should be granted immediately (burst = 3)
  for (let i = 0; i < 3; i++) {
    const r = await tb.acquire({ timeoutMs: 100 });
    assert(r.granted === true, `burst ${i+1} granted`);
  }

  // 2. 4th request should NOT be granted immediately (bucket empty)
  const r4 = tb.getStatus();
  assert(r4.tokens < 1, "bucket empty after burst");
  assert(r4.concurrent === 0, "concurrent 0 before slots");

  // 3. Acquire slots to test concurrency limit
  tb.acquireSlot();
  tb.acquireSlot();
  const s2 = tb.getStatus();
  assert(s2.concurrent === 2, "concurrent = 2 after 2 acquireSlot");

  // 4. Max concurrent reached — acquire should queue
  const p3 = tb.acquire({ timeoutMs: 2000 });
  await sleep(10);
  const s3 = tb.getStatus();
  assert(s3.queued === 1, "queued 1 at max concurrent");

  // 5. Release one slot → waiter drains
  tb.releaseSlot();
  const result = await Promise.race([p3, sleep(500).then(() => ({ granted: false }))]);
  assert(result.granted === true, "waiter drained after release");

  // 6. Refill test — wait for tokens to come back
  tb.dispose();
  const tb2 = new TokenBucketStrategy({ burstSize: 2, refillRate: 50, maxConcurrent: 5 });
  // Exhaust tokens
  await tb2.acquire({ timeoutMs: 100 });
  await tb2.acquire({ timeoutMs: 100 });
  assert(tb2.getStatus().tokens < 1, "tokens exhausted");
  // Wait for refill (~40ms for 2 tokens at 50/s)
  await sleep(80);
  const refill = await tb2.acquire({ timeoutMs: 100 });
  assert(refill.granted === true, "token refill works");
  tb2.dispose();

  console.log("  ✓ token-bucket tests done\n");
}

/* ── Sliding Window ───────────────────────────────────── */
console.log("SlidingWindowStrategy");
{
  // Short window (500ms) for fast testing
  const sw = new SlidingWindowStrategy({ windowMs: 500, maxRpm: 3, maxConcurrent: 2 });

  // 1. First 3 requests granted (maxRpm = 3)
  for (let i = 0; i < 3; i++) {
    const r = await sw.acquire({ timeoutMs: 100 });
    assert(r.granted === true, `window req ${i+1} granted`);
  }

  // 2. 4th request should queue (long timeout so it survives past window slide)
  const p4 = sw.acquire({ timeoutMs: 10000 });
  await sleep(10);
  const s1 = sw.getStatus();
  assert(s1.queued === 1, "queued at maxRpm");
  assert(s1.countInWindow === 3, "countInWindow = 3");

  // 3. Wait for window to slide past (500ms window + 100ms margin)
  await sleep(700);
  const result = await Promise.race([p4, sleep(2000).then(() => ({ granted: false }))]);
  assert(result.granted === true, "waiter drained after window slide");

  sw.dispose();
  console.log("  ✓ sliding-window tests done\n");
}

/* ── Concurrency + Abort ──────────────────────────────── */
console.log("Abort handling");
{
  const tb = new TokenBucketStrategy({ burstSize: 1, refillRate: 1, maxConcurrent: 1 });
  await tb.acquire({ timeoutMs: 100 });
  tb.acquireSlot();

  // Second acquire should queue, then abort
  const ac = new AbortController();
  const p = tb.acquire({ signal: ac.signal, timeoutMs: 5000 });
  await sleep(10);
  ac.abort();
  const r = await p;
  assert(r.granted === false, "aborted waiter returns false");

  tb.dispose();
  console.log("  ✓ abort test done\n");
}

/* ── Strategy update (hot-reload) ─────────────────────── */
console.log("Hot-reload config");
{
  const tb = new TokenBucketStrategy({ burstSize: 1, refillRate: 1, maxConcurrent: 10 });
  tb.update({ burstSize: 5, maxConcurrent: 20 });
  const s = tb.getStatus();
  assert(s.burstSize === 5, "burstSize updated");
  assert(s.maxConcurrent === 20, "maxConcurrent updated");
  tb.dispose();
  console.log("  ✓ hot-reload test done\n");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
