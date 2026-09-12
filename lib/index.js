/**
 * dsh-llm-rate-limiter — Host (server-side) entry point.
 *
 * Intercepts the `llm/stream` waterfall and enforces per-model rate limits.
 * Configuration lives in the "llm-rate-limiter" settings namespace, editable
 * from the browser GUI.
 *
 * The `llm/stream` waterfall signature is:
 *   (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
 *
 * where `options` always has `.provider` (string) and `.model` (string).
 *
 * The settings service is injected dynamically (like dshmarket's
 * installMarketSettings): `ctx.inject(['settings'], (scopedCtx) => ...)`, so a
 * host without a settings provider simply runs without the GUI wiring — the
 * composed entry stays as configured. Inherited from the DSH house pattern.
 *
 * @module dsh-llm-rate-limiter
 */

import { TokenBucketStrategy } from "./strategies/token-bucket.js";
import { SlidingWindowStrategy } from "./strategies/sliding-window.js";
import { RateLimiterConfig } from "./types/config.js";

const name = "llm-rate-limiter";
const SETTINGS_NS = "llm-rate-limiter";

/* ── Helpers ─────────────────────────────────────────────────────────── */

/**
 * Merge defaults + per-model overrides into a flat config object that both
 * strategy constructors understand.
 */
function resolveModelConfig(cfg, key) {
  const o = cfg.models?.[key] ?? {};
  const d = cfg.defaults ?? {};
  const maxRpm = o.maxRpm ?? d.maxRpm ?? 60;
  // When a model overrides maxRpm but not refillRate, derive refillRate from
  // the model's maxRpm — this is the most common case ("set maxRpm=3").
  // When model doesn't override maxRpm, use the defaults' refillRate as-is.
  const refillRate = o.refillRate ?? (o.maxRpm != null ? o.maxRpm / 60 : d.refillRate ?? (maxRpm / 60));
  return {
    maxConcurrent: o.maxConcurrent ?? d.maxConcurrent ?? 5,
    maxRpm,
    burstSize:     o.burstSize     ?? d.burstSize     ?? 10,
    refillRate,
    windowMs:      d.windowMs      ?? 60_000,
  };
}

/**
 * Ensure a rate-limiting strategy instance exists (or is updated) for `key`.
 */
function ensureLimiter(limiters, key, cfg) {
  const merged = resolveModelConfig(cfg, key);
  const existing = limiters.get(key);
  if (existing) {
    existing.update(merged);
    return existing;
  }
  const strategy = cfg.strategy === "sliding-window"
    ? new SlidingWindowStrategy(merged)
    : new TokenBucketStrategy(merged);
  limiters.set(key, strategy);
  return strategy;
}

/**
 * Build a terminal StreamChunk for rate-limiting failures.
 * Uses `kind: "aborted"` when the caller's AbortSignal fired, so the agent
 * loop treats it as a cancellation rather than a retryable error.
 * Otherwise uses `kind: "error"` with `RATE_LIMIT` code, which the
 * `dsh-llm-retry` plugin can catch and back off.
 */
function terminalChunk(modelKey, signal) {
  const aborted = signal?.aborted === true;
  return {
    type: "finish",
    reason: aborted
      ? { kind: "aborted", failure: { code: "RATE_LIMIT", message: `Rate limit: ${modelKey} (aborted)` } }
      : { kind: "error", failure: { code: "RATE_LIMIT", message: `Rate limit exceeded for ${modelKey}` } },
  };
}

/* ── Plugin entry ────────────────────────────────────────────────────── */

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
function apply(ctx) {
  const logger = ctx.logger?.("rate-limiter");

  // Shared mutable config state.  Starts with built-in defaults; once the
  // settings service is available the watcher replaces it with the live
  // user-configured value on every change.
  const defaultBase = {
    enabled: true,
    strategy: "token-bucket",
    defaults: { maxConcurrent: 5, maxRpm: 60, burstSize: 10, refillRate: 1 },
    models: {},
    onThrottled: "queue",
    maxQueueWaitMs: 60_000,
  };
  let cfg = { ...defaultBase };

  /** @type {Map<string, TokenBucketStrategy | SlidingWindowStrategy>} */
  const limiters = new Map();

  // ── Settings wiring (dynamic inject) ───────────────────────
  // Wrapped in ctx.inject so the plugin works on older DSH versions that
  // don't have a settings service at all — the callback simply never runs.
  ctx.inject(["settings"], (scopedCtx) => {
    const scope = scopedCtx.settings.register(SETTINGS_NS, RateLimiterConfig, {
      base: defaultBase,
    });

    logger?.info("rate limiter settings namespace registered (%s)", SETTINGS_NS);

    // Replace cfg with live settings value on every change.
    cfg = scope.get();
    scope.watch((c) => { cfg = c; });

    // Dispose limiters on settings teardown.
    scopedCtx.effect(() => () => {
      logger?.info("rate limiter settings scope tearing down (%s)", SETTINGS_NS);
      for (const limiter of limiters.values()) limiter.dispose();
      limiters.clear();
    }, "rate-limiter: settings scope teardown");
  });

  // ── LLM stream interceptor ─────────────────────────────────
  // ctx.on('llm/stream') doesn't need the settings service — it's a plain
  // waterfall listener that reads the shared `cfg` variable (initialised
  // with defaults; replaced by the settings watcher when available).
  const disposeLlmListener = ctx.on("llm/stream", async function* rateLimitInterceptor(options, next) {
    if (!cfg.enabled) {
      yield* next();
      return;
    }

    const modelKey = `${options.provider}/${options.model}`;

    // Per-model opt-out: `enabled: false` skips this model entirely.
    if (cfg.models?.[modelKey]?.enabled === false) {
      yield* next();
      return;
    }

    const limiter = ensureLimiter(limiters, modelKey, cfg);

    // ── Phase 1: acquire ────────────────────────────────────────
    let slotTaken = false;
    if (cfg.onThrottled === "reject") {
      // Non-blocking check — if at capacity, yield a terminal chunk immediately.
      // acquireNonBlocking deducts a token AND takes a concurrent slot, so
      // reject mode still enforces the frequency limit, not just concurrency.
      const permit = limiter.acquireNonBlocking();
      if (!permit.granted) {
        logger?.warn("model %C rejected — rate limit reached", modelKey);
        yield terminalChunk(modelKey, options.signal);
        return;
      }
      // permit granted → slot already taken by acquireNonBlocking; skip acquireSlot.
      slotTaken = true;
    } else {
      // Queue mode — park until a slot opens.
      const permit = await limiter.acquire({
        signal: options.signal,
        timeoutMs: cfg.maxQueueWaitMs ?? 60_000,
      });
      if (!permit.granted) {
        logger?.warn(
          "model %C %s after %d ms",
          modelKey, options.signal?.aborted ? "aborted" : "queue timeout", permit.waitMs,
        );
        yield terminalChunk(modelKey, options.signal);
        return;
      }
      // Queue mode: acquire() does NOT take a concurrent slot.
      // We must call acquireSlot() before the actual call.
      slotTaken = false;
    }

    // ── Phase 2: run the real LLM call ─────────────────────────
    if (!slotTaken) limiter.acquireSlot();
    try {
      yield* next();
    } finally {
      limiter.releaseSlot();
    }
  });

  // ── Teardown ──
  ctx.effect(() => () => {
    disposeLlmListener();
    for (const limiter of limiters.values()) limiter.dispose();
    limiters.clear();
  }, "rate-limiter: dispose llm/stream listener");

  logger?.info("rate limiter active — llm/stream interceptor registered");
}

export { apply, name, SETTINGS_NS };