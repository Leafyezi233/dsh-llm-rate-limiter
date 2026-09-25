/**
 * dsh-llm-rate-limiter — status RPC channel (Host half).
 *
 * Exposes live rate-limiter statistics to the browser over the framework's
 * generic Connection RPC channel. The framework supplies POST+JSON transport,
 * the Host/Origin fence (403) and browser authentication (401); this module
 * only answers endpoints and shapes envelopes.
 *
 * Two mounting paths exist, and both speak the *same* wire protocol so the
 * browser half never needs to know which one is active:
 *
 *  1. `connection.rpc.handle(channel, handler)` — the framework's own generic
 *     channel registry. Preferred: the framework owns the route, the request
 *     validation, and the fiber-scoped withdrawal.
 *
 *  2. `createChannelRoute({ channel, handler, reject })` — a self-registered
 *     prefix route for hosts where path 1 is broken. DSH 0.1.5-rc.3 changed
 *     `@deepseek-ai/dsh-client-connection`'s own `inject` from
 *     `["webServer", "credentials"]` to `["credentials"]` while
 *     `HostConnectionService.register()` still dereferences
 *     `owner.webServer`, so `rpc.handle` throws
 *     `cannot get property "webServer" without inject`. This route is
 *     registered on our own fiber (which *can* see `webServer`) and reuses the
 *     connection service's public `requestRejection()` fence, so the 403/401
 *     policy is still the framework's.
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
 * Endpoint grammar for one path segment, copied verbatim from the framework's
 * `ENDPOINT_SEGMENT_PATTERN` in dsh-client-connection. Keeping it identical is
 * what makes the self-registered route accept and reject exactly the same URLs
 * as `rpc.handle` would.
 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/**
 * Buffered-body cap for the self-registered route. Both endpoints are called
 * with an empty payload, so this is a defensive memory bound rather than a
 * real limit (the framework uses its own, much larger, carrier cap).
 */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * Correlation id echoed when the request envelope cannot be parsed at all —
 * the same literal the framework uses (`INVALID_REQUEST_RPC_ID`).
 */
const INVALID_REQUEST_RPC_ID = "invalid-request";

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

/* ── self-registered route (the DSH 0.1.5-rc.3 fallback) ───────────────── */

/** Narrow an unknown JSON value to a plain object. */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the endpoint from a channel-relative pathname, mirroring the
 * framework's `endpointFromPath`: a single `channel/<endpoint>` segment whose
 * segments all satisfy {@link ENDPOINT_SEGMENT_PATTERN}.
 *
 * @param {string} channel - the channel prefix (e.g. `/llm-rate-limiter`).
 * @param {string} pathname - request pathname.
 * @returns {string | undefined} the endpoint, or undefined when the URL is not
 *   a well-formed member of this channel.
 */
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  const segments = endpoint.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT_PATTERN.test(segment))) return undefined;
  return endpoint;
}

/**
 * Read and decode the request body, refusing anything above `limit` bytes so a
 * hostile caller cannot make the host buffer without bound.
 *
 * @param {import("node:http").IncomingMessage} req - node request stream.
 * @param {number} limit - maximum accepted byte count.
 * @returns {Promise<string>} the decoded UTF-8 body.
 * @throws {Error & { code: "TOO_LARGE" }} when the body exceeds `limit`.
 */
async function readBody(req, limit) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    received += buffer.byteLength;
    if (received > limit) {
      const error = new Error("request body too large");
      error.code = "TOO_LARGE";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Write one `server-response` envelope as JSON — byte-for-byte the shape
 * `Response.json(...)` produces on the framework's own route.
 *
 * @param {import("node:http").ServerResponse} res - response to own.
 * @param {string} rpcId - correlation id to echo.
 * @param {object} result - the `{ ok, value }` / `{ ok, error }` envelope.
 */
function sendEnvelope(res, rpcId, result) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "server-response", rpcId, result }));
}

/**
 * Build a webserver prefix route that speaks the Connection RPC wire protocol.
 *
 * This is the fallback carrier for {@link createStatusChannel} on hosts where
 * `connection.rpc.handle` throws. Every request-shape decision mirrors the
 * framework's `rpcFetchHandler` so the browser half is byte-compatible with the
 * preferred path:
 *
 * | condition | response |
 * |---|---|
 * | fence/auth rejected by `reject` | `403` (or `401`) + `forbidden`/`unauthorized` |
 * | non-POST, or URL outside the channel | `404 not found` |
 * | `content-type` not `application/json` | `415` |
 * | body over {@link MAX_REQUEST_BODY_BYTES} | `413` |
 * | body not JSON | `400 body is not JSON` |
 * | envelope not a `client-request` | `gateway/bad-request` envelope |
 * | `method` ≠ endpoint | `gateway/bad-request` envelope |
 * | handler threw | `500 handler failure: ...` |
 * | otherwise | `200` + `server-response` envelope |
 *
 * @param {object} deps
 * @param {string} deps.channel - channel prefix to own (e.g. `/llm-rate-limiter`).
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<object>} deps.handler - endpoint dispatcher.
 * @param {(req: import("node:http").IncomingMessage) => number | undefined} deps.reject - the framework's `connection.requestRejection` fence; returns an HTTP status to refuse with, or undefined to allow.
 * @returns {{ kind: "prefix", path: string, handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void> }}
 */
function createChannelRoute({ channel, handler, reject }) {
  return {
    kind: "prefix",
    path: channel,
    handler: async (req, res) => {
      // 1. The framework's own fence: Host/Origin trust (403) then browser
      //    authentication (401). Reusing it keeps the security policy identical.
      const rejection = reject(req);
      if (rejection !== undefined) {
        res.writeHead(rejection);
        res.end(rejection === 401 ? "unauthorized" : "forbidden");
        return;
      }

      // 2. POST-only, and only inside this channel (framework: 404 otherwise).
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const endpoint = endpointFromPath(channel, url.pathname);
      if (req.method !== "POST" || endpoint === undefined) {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      // 3. JSON only (framework: 415).
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") {
        res.writeHead(415);
        res.end("content type must be application/json");
        return;
      }

      // 4. Buffer the body under a defensive cap, then parse it.
      let raw;
      try {
        raw = await readBody(req, MAX_REQUEST_BODY_BYTES);
      } catch (error) {
        if (error?.code === "TOO_LARGE") {
          res.writeHead(413, { connection: "close" });
          res.end();
          req.destroy?.();
          return;
        }
        throw error;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400);
        res.end("body is not JSON");
        return;
      }

      // 5. Validate the client-request envelope; echo the correlation id
      //    whenever it is a string, exactly like the framework does.
      const rpcId = typeof body?.rpcId === "string" ? body.rpcId : INVALID_REQUEST_RPC_ID;
      if (!isRecord(body) || body.type !== "client-request" || typeof body.rpcId !== "string" || typeof body.method !== "string") {
        sendEnvelope(res, rpcId, failure("gateway/bad-request", "invalid client-request message", { issues: [] }));
        return;
      }
      if (body.method !== endpoint) {
        sendEnvelope(res, rpcId, failure(
          "gateway/bad-request",
          `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          { issues: [] },
        ));
        return;
      }

      // 6. Dispatch. Tie the signal to the response lifetime, as the framework's
      //    http bridge does, so a dropped client can cancel the work.
      const abort = new AbortController();
      res.on?.("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      let result;
      try {
        result = await handler(endpoint, body.payload, abort.signal);
      } catch (error) {
        res.writeHead(500);
        res.end(`handler failure: ${String(error)}`);
        return;
      }
      sendEnvelope(res, rpcId, result);
    },
  };
}

export {
  CHANNEL,
  MAX_REQUEST_BODY_BYTES,
  createChannelRoute,
  createStatusChannel,
  endpointFromPath,
  failure,
  success,
};
