/**
 * Sliding-Window rate limiter strategy.
 *
 * Counts requests inside a rolling window of `windowMs` milliseconds.
 * The window slides continuously: each request's timestamp is recorded,
 * and the count is the number of timestamps inside the window.
 *
 * Concurrency is controlled separately (same as TokenBucketStrategy).
 *
 * @module dsh-llm-rate-limiter/strategies/sliding-window
 */

export class SlidingWindowStrategy {
  /** @type {{ windowMs: number, maxRpm: number, maxConcurrent: number }} */
  #cfg;
  #concurrent = 0;
  /** @type {number[]} — timestamps (Date.now()) inside the window */
  #timestamps = [];
  /** @type {Array<{ resolve: (r: { granted: boolean }) => void, abort: () => void }>} */
  #waiters = [];
  #timer;

  /**
   * @param {object} config — `{ windowMs, maxRpm, maxConcurrent }`
   */
  constructor(config) {
    this.#cfg = { ...config };
    // Prune stale timestamps every second.
    this.#timer = setInterval(() => this.#prune(), 1_000);
  }

  /* ── public API ─────────────────────────────────────── */

  acquire({ signal, timeoutMs }) {
    const t0 = Date.now();

    if (signal?.aborted) return Promise.resolve({ granted: false });

    // Fast path: concurrency AND window capacity both available.
    if (this.#concurrent < this.#cfg.maxConcurrent && this.#count() < this.#cfg.maxRpm) {
      this.#timestamps.push(Date.now());
      return Promise.resolve({ granted: true });
    }

    if (this.#cfg.maxConcurrent <= 0) return Promise.resolve({ granted: false });

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
        resolve: () => onDone({ granted: true }),
        abort: onAbort,
      };

      this.#waiters.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Non-blocking acquisition: record the request in the window and take an
   * implicit concurrent slot if both are available right now, without parking
   * in the queue.
   *
   * Used by "reject" throttle mode, which must not wait, but must still count
   * the request so the rate limit is enforced.
   *
   * @returns {{ granted: boolean }} — granted means the request was counted
   *   and a concurrent slot taken; the caller MUST pair it with `releaseSlot()`.
   */
  acquireNonBlocking() {
    if (this.#concurrent < this.#cfg.maxConcurrent && this.#count() < this.#cfg.maxRpm) {
      this.#timestamps.push(Date.now());
      this.#concurrent += 1;
      return { granted: true };
    }
    return { granted: false };
  }

  acquireSlot() {
    this.#concurrent += 1;
  }

  releaseSlot() {
    this.#concurrent = Math.max(0, this.#concurrent - 1);
    this.#drain();
  }

  getStatus() {
    return {
      strategy: "sliding-window",
      windowMs: this.#cfg.windowMs,
      countInWindow: this.#count(),
      maxRpm: this.#cfg.maxRpm,
      concurrent: this.#concurrent,
      maxConcurrent: this.#cfg.maxConcurrent,
      queued: this.#waiters.length,
    };
  }

  update(config) {
    Object.assign(this.#cfg, config);
  }

  dispose() {
    clearInterval(this.#timer);
    for (const w of this.#waiters) w.abort();
    this.#waiters = [];
  }

  /* ── internals ─────────────────────────────────────── */

  /** Number of timestamps inside the current window. */
  #count() {
    const cutoff = Date.now() - this.#cfg.windowMs;
    // timestamps are pushed in order, so find the first that's still inside.
    let i = 0;
    while (i < this.#timestamps.length && this.#timestamps[i] <= cutoff) i += 1;
    return this.#timestamps.length - i;
  }

  /** Remove timestamps that fell out of the window. */
  #prune() {
    const cutoff = Date.now() - this.#cfg.windowMs;
    while (this.#timestamps.length > 0 && this.#timestamps[0] <= cutoff) {
      this.#timestamps.shift();
    }
    this.#drain();
  }

  /** Drain waiters as long as capacity is available. */
  #drain() {
    while (this.#waiters.length > 0 && this.#count() < this.#cfg.maxRpm && this.#concurrent < this.#cfg.maxConcurrent) {
      this.#timestamps.push(Date.now());
      const waiter = this.#waiters.shift();
      waiter?.resolve();
    }
  }
}
