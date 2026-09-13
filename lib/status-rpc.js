/**
 * dsh-llm-rate-limiter — status RPC channel (Host half).
 *
 * Exposes live rate-limiter statistics to the browser over the framework's
 * generic Connection RPC channel — the same idiom dsh-context uses for its
 * detail channel. The framework supplies POST+JSON transport, the Host/Origin
 * fence (403) and browser authentication (401); this module only answers
 * endpoints and shapes envelopes.
 *
 * Registration is owned by the calling fiber (`register()` wraps
 * `owner.webServer.register` in `owner.effect`), so unloading the plugin
 * withdraws the channel automatically — there is no connection bookkeeping
 * here.
 *
 * Envelope contract (mirrors the Connection wire schema):
 *   success: { ok: true,  value: <JSON-safe> }
 *   failure: { ok: false, error: { code, message, details } }
 *
 * @module dsh-llm-rate-limiter/status-rpc
 */

/**
 * Channel name. Must satisfy the framework's `assertChannel` pattern
 * `/^\/[A-Za-z0-9._~-]+$/` and must not be the reserved `/api` channel.
 */
const CHANNEL = "/llm-rate-limiter";

/**
 * Build a failure envelope. Field-for-field the same shape the Connection
 * host accepts, so callers can rely on `ok` discrimination alone.
 * @param {string} code - stable machine-readable error code.
 * @param {string} message - human-readable detail.
 * @param {Record<string, unknown>} [details] - optional structured context.
 * @returns {{ ok: false, error: { code: string, message: string, details: Record<string, unknown> } }}
 */
function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

/** Build a success envelope. */
function success(value) {
  return { ok: true, value };
}

/**
 * Create the channel handler.
 *
 * @param {object} deps
 * @param {() => object} deps.buildSnapshot - live snapshot builder.
 * @param {() => void} deps.resetTotals - zero the counters (and bump `rev`).
 * @returns {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<object>}
 */
function createStatusChannel({ buildSnapshot, resetTotals }) {
  return async function statusChannel(endpoint) {
    if (endpoint === "snapshot") return success(buildSnapshot());
    if (endpoint === "reset") {
      resetTotals();
      return success({});
    }
    return failure(
      "llm-rate-limiter/unknown-endpoint",
      `unknown endpoint: ${String(endpoint)}`,
    );
  };
}

export { CHANNEL, createStatusChannel, failure, success };
