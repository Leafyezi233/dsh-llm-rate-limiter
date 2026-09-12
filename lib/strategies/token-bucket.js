/**
 * Token-Bucket rate limiter strategy.
 *
 * Each model gets its own bucket.  A bucket has:
 *  - `burstSize`  — maximum tokens the bucket can hold
 *  - `refillRate` — tokens added per second
 *  - a concurrent-slot counter (separate from tokens, so burst + concurrency are orthogonal)
 *
 * When the bucket is empty the request is queued (a promise resolver parked in
 * `waiters[]`).  As tokens refill, waiters are drained in FIFO order.
 *
 * @module dsh-llm-rate-limiter/strategies/token-bucket
 */

export class TokenBucketStrategy {
  /** @type {{ burstSize: number, refillRate: number, maxConcurrent: number }} */
  #cfg;
  #tokens;
  #lastRefill;
  #concurrent = 0;
  /** @type {Array<{ resolve: (r: { granted: boolean }) => void, abort: () => void }>} */
  #waiters = [];
  #timer;

  /**
   * @param {object} config — `{ burstSize, refillRate, maxConcurrent }`
   */
  constructor(config) {
    this.#cfg = { ...config };
    this.#tokens = config.burstSize;
    this.#lastRefill = Date.now();
    this.#startRefill();
  }

  /* ── public API ─────────────────────────────────────── */

  /**
   * Wait until a request is allowed.
   * Resolves `{ granted: true }` immediately or after the queue drains.
   * Resolves `{ granted: false }` on abort or timeout (timeout is the caller's
   * responsibility — it races this promise against a timer).
   *
   * @param {{ signal?: AbortSignal, timeoutMs: number }} opts
   * @returns {Promise<{ granted: boolean, waitMs?: number }>}
   */
  acquire({ signal, timeoutMs }) {
    const t0 = Date.now();

    // Already aborted — fail fast.
    if (signal?.aborted) {
      return Promise.resolve({ granted: false });
    }

    // Fast path: concurrency room AND a token available.
    if (this.#concurrent < this.#cfg.maxConcurrent && this.#tokens >= 1) {
      this.#tokens -= 1;
      return Promise.resolve({ granted: true });
    }

    // Slow path: park in the waiter queue.
    if (this.#cfg.maxConcurrent <= 0) {
      return Promise.resolve({ granted: false });
    }

    return new Promise((resolve) => {
      const onDone = (result) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const idx = this.#waiters.indexOf(entry);
        if (idx >= 0) this.#waiters.splice(idx, 1);
        resolve({ ...result, waitMs: Date.now() - t0 });
      };

      const onAbort = () => onDone({ granted: false });

      const timer = setTimeout(() => onDone({ granted: false }), timeoutMs);

      const entry = {
        resolve: () => {
          // Token already deducted by _drain.
          onDone({ granted: true });
        },
        abort: onAbort,
      };

      this.#waiters.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Non-blocking acquisition: consume a token and an implicit concurrent slot
   * if both are available right now, without parking in the queue.
   *
   * Used by "reject" throttle mode, which must not wait, but must still deduct
   * tokens so the rate limit is enforced (otherwise only the concurrency cap
   * would bite).
   *
   * @returns {{ granted: boolean }} — granted means a token was consumed and a
   *   concurrent slot taken; the caller MUST pair it with `releaseSlot()`.
   */
  acquireNonBlocking() {
    if (this.#concurrent < this.#cfg.maxConcurrent && this.#tokens >= 1) {
      this.#tokens -= 1;
      this.#concurrent += 1;
      return { granted: true };
    }
    return { granted: false };
  }

  /** Mark one concurrent slot as in-use. */
  acquireSlot() {
    this.#concurrent += 1;
  }

  /** Release one concurrent slot and try to drain waiters. */
  releaseSlot() {
    this.#concurrent = Math.max(0, this.#concurrent - 1);
    this.#drain();
  }

  /** Live snapshot for the GUI. */
  getStatus() {
    return {
      strategy: "token-bucket",
      tokens: Math.round(this.#tokens * 100) / 100,
      burstSize: this.#cfg.burstSize,
      refillRate: this.#cfg.refillRate,
      concurrent: this.#concurrent,
      maxConcurrent: this.#cfg.maxConcurrent,
      queued: this.#waiters.length,
    };
  }

  /** Replace config at runtime (hot-reload). */
  update(config) {
    Object.assign(this.#cfg, config);
  }

  /** Dispose — release all waiters and stop the refill timer. */
  dispose() {
    clearInterval(this.#timer);
    for (const w of this.#waiters) w.abort();
    this.#waiters = [];
  }

  /* ── internals ─────────────────────────────────────── */

  #startRefill() {
    // Refill every 50 ms for smooth granularity.
    this.#timer = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.#lastRefill) / 1000;
      this.#tokens = Math.min(this.#cfg.burstSize, this.#tokens + elapsed * this.#cfg.refillRate);
      this.#lastRefill = now;
      this.#drain();
    }, 50);
  }

  /** Drain waiters as long as we have tokens and concurrency room. */
  #drain() {
    while (this.#waiters.length > 0 && this.#tokens >= 1 && this.#concurrent < this.#cfg.maxConcurrent) {
      this.#tokens -= 1;
      const waiter = this.#waiters.shift();
      waiter?.resolve();
    }
  }
}
