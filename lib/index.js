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
import { CHANNEL, createChannelRoute, createStatusChannel } from "./status-rpc.js";

const name = "llm-rate-limiter";
const SETTINGS_NS = "llm-rate-limiter";

/** Maximum retained events in the status ring (bounded memory). */
const EVENT_RING_LIMIT = 64;
/** Events carried by one snapshot (the panel shows these). */
const SNAPSHOT_EVENT_COUNT = 8;

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

  // ── Live statistics (read by the status RPC channel) ───────
  // Counters are plain numbers so a snapshot is always JSON-safe.
  const totals = {
    requests: 0,
    granted: 0,
    rejected: 0,
    timeouts: 0,
    aborted: 0,
    totalWaitMs: 0,
  };
  /** Bumped on every recorded event and on reset — the panel's change cursor. */
  let rev = 0;
  /** Bounded ring of recent events (newest last). */
  const eventRing = [];

  function recordEvent(event) {
    eventRing.push({ ...event, ts: Date.now() });
    if (eventRing.length > EVENT_RING_LIMIT) eventRing.shift();
    rev += 1;
  }

  /** Build the JSON-safe snapshot served on the "snapshot" endpoint. */
  function buildSnapshot() {
    const models = {};
    for (const [key, limiter] of limiters) {
      try {
        models[key] = limiter.getStatus();
      } catch {
        // A strategy that cannot report status must not break the whole panel.
      }
    }
    return {
      rev,
      ts: Date.now(),
      enabled: cfg.enabled !== false,
      strategy: cfg.strategy,
      onThrottled: cfg.onThrottled,
      totals: { ...totals },
      models,
      events: eventRing.slice(-SNAPSHOT_EVENT_COUNT),
    };
  }

  /** Zero every counter and drop retained events (the panel's clear button). */
  function resetTotals() {
    for (const key of Object.keys(totals)) totals[key] = 0;
    eventRing.length = 0;
    rev += 1;
  }

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

  // ── Status channel (dynamic inject) ────────────────────────
  // Same defensive shape as the settings wiring: on a host without a
  // connection service the callback never runs and the plugin stays silent.
  // Either path below registers inside an effect owned by this fiber, so
  // unloading the plugin withdraws the channel automatically.
  //
  // Two mounting paths exist, and both speak the same wire protocol, so the
  // browser half never needs to know which one is live:
  //
  //   1. connection.rpc.handle(channel, handler) — the framework's generic
  //      channel registry (preferred: the framework owns the route, the
  //      request validation, and the withdrawal).
  //
  //   2. a self-registered prefix route reusing connection.requestRejection()
  //      — the fallback for hosts where path 1 is broken. DSH 0.1.5-rc.3
  //      changed dsh-client-connection's own `inject` from
  //      ["webServer", "credentials"] to ["credentials"] while its
  //      HostConnectionService.register() still dereferences
  //      `owner.webServer`, and Cordis rebinds a cross-fiber service's `ctx`
  //      to the *reader's* fiber — so rpc.handle() throws
  //      'cannot get property "webServer" without inject'. Registering the
  //      route on our own fiber (which injects webServer below) avoids that
  //      while still using the framework's own 403/401 fence.
  ctx.inject(["connection"], (scopedCtx) => {
    const connection = scopedCtx.get("connection");
    const channel = createStatusChannel({ buildSnapshot, resetTotals });

    // ── Path 1: the framework's generic channel registry ──
    const handle = typeof connection?.rpc?.handle === "function"
      ? connection.rpc.handle.bind(connection.rpc)
      : undefined;

    if (handle !== undefined) {
      try {
        scopedCtx.effect(() => {
          const unregister = handle(CHANNEL, channel);
          return () => { unregister(); };
        }, "rate-limiter: status rpc channel");
        logger?.info("rate limiter status channel mounted via connection.rpc (%s)", CHANNEL);
        return;
      } catch (err) {
        logger?.warn(
          "connection.rpc channel registration failed (%s); falling back to a self-registered route",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // ── Path 2: self-registered route (needs webServer on THIS fiber) ──
    // The fence is mandatory: without connection.requestRejection() we would
    // be publishing an unauthenticated route, so we refuse to mount at all.
    // Probing once here turns a broken fence into a mount-time refusal instead
    // of a per-request surprise.
    try {
      if (typeof connection?.requestRejection !== "function") {
        logger?.warn("connection.requestRejection unavailable; status channel not mounted");
        return;
      }
      connection.requestRejection({ headers: {} });
    } catch (err) {
      logger?.warn(
        "connection.requestRejection unusable (%s); refusing to mount an unfenced status route",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    scopedCtx.inject(["webServer"], (webCtx) => {
      const webServer = webCtx.get("webServer");
      if (typeof webServer?.register !== "function") return; // no web carrier: degrade silently

      try {
        webCtx.effect(() => webServer.register(createChannelRoute({
          channel: CHANNEL,
          handler: channel,
          reject: (req) => connection.requestRejection(req),
        })), "rate-limiter: status route (self-registered)");
      } catch (err) {
        logger?.warn("status channel registration failed: %s", err instanceof Error ? err.message : String(err));
        return;
      }

      logger?.info("rate limiter status channel mounted via self-registered route (%s)", CHANNEL);
    });
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
    totals.requests += 1;

    // ── Phase 1: acquire ────────────────────────────────────────
    let slotTaken = false;
    if (cfg.onThrottled === "reject") {
      // Non-blocking check — if at capacity, yield a terminal chunk immediately.
      // acquireNonBlocking deducts a token AND takes a concurrent slot, so
      // reject mode still enforces the frequency limit, not just concurrency.
      const permit = limiter.acquireNonBlocking();
      if (!permit.granted) {
        totals.rejected += 1;
        recordEvent({ event: "rejected", model: modelKey });
        logger?.warn("model %C rejected — rate limit reached", modelKey);
        yield terminalChunk(modelKey, options.signal);
        return;
      }
      // permit granted → slot already taken by acquireNonBlocking; skip acquireSlot.
      slotTaken = true;
      totals.granted += 1;
      recordEvent({ event: "granted", model: modelKey, waitMs: 0 });
    } else {
      // Queue mode — park until a slot opens.
      const permit = await limiter.acquire({
        signal: options.signal,
        timeoutMs: cfg.maxQueueWaitMs ?? 60_000,
      });
      if (!permit.granted) {
        const aborted = options.signal?.aborted === true;
        if (aborted) {
          totals.aborted += 1;
          recordEvent({ event: "aborted", model: modelKey, waitMs: permit.waitMs ?? 0 });
        } else {
          totals.timeouts += 1;
          recordEvent({ event: "timeout", model: modelKey, waitMs: permit.waitMs ?? 0 });
        }
        logger?.warn(
          "model %C %s after %d ms",
          modelKey, aborted ? "aborted" : "queue timeout", permit.waitMs,
        );
        yield terminalChunk(modelKey, options.signal);
        return;
      }
      // Queue mode: acquire() does NOT take a concurrent slot.
      // We must call acquireSlot() before the actual call.
      slotTaken = false;
      totals.granted += 1;
      totals.totalWaitMs += permit.waitMs ?? 0;
      recordEvent({ event: "granted", model: modelKey, waitMs: permit.waitMs ?? 0 });
    }

    // ── Phase 2: run the real LLM call ─────────────────────────
    if (!slotTaken) limiter.acquireSlot();
    try {
      yield* next();
    } finally {
      limiter.releaseSlot();
      recordEvent({ event: "completed", model: modelKey });
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