# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.1] - 2026-09-25

### Fixed
- **Live status panel stopped working on DSH 0.1.5-rc.3** — the channel silently failed to mount and the panel sat on "○ 重试中" forever. Root cause is upstream: DSH 0.1.5-rc.3 changed `@deepseek-ai/dsh-client-connection`'s own `inject` from `["webServer", "credentials"]` to `["credentials"]`, while `HostConnectionService.register()` still dereferences `owner.webServer`. Cordis rebinds a cross-fiber service's `ctx` to the *reader's* fiber, so `connection.rpc.handle()` threw `cannot get property "webServer" without inject` — which the plugin's own try/catch swallowed.
- The plugin now falls back to a **self-registered `kind: "prefix"` route** on its own fiber (which can see `webServer`) and reuses `connection.requestRejection()` for the 403/401 fence. Both carriers speak the identical wire protocol, so **`lib/client.js` is unchanged**.

### Added
- `createChannelRoute({ channel, handler, reject })` and `endpointFromPath()` in `lib/status-rpc.js` — a Connection-RPC-compatible webserver prefix route, mirroring the framework's `rpcFetchHandler` request-shape decisions (404 / 415 / 413 / 400 / `gateway/bad-request` / 500 / 200)
- `test-status-route.mjs` (73 assertions) in four layers: route grammar, request-shape decisions, a simulated 0.1.5 regression (proves both the fallback *and* the preference for `rpc.handle` when it works), and the real 0.1.5 package (auto-skips when DSH is absent)
- `tools/verify-live-route.mjs` (19 assertions) — boots the real `dsh-host-webserver` on a real socket plus the real `dsh-client-connection`, then issues real HTTP requests; exits 2 (skipped) without a DSH install
- `pnpm run verify:live` script

### Changed
- `dsh.compatibility.dshReleases` now declares `0.1.5-rc.3` as compatible alongside `0.1.2-rc.1`
- The status channel's mount log now names the active carrier (`connection.rpc` vs `self-registered route`), and a failed path-1 registration is reported as a warning instead of being swallowed
- If `connection.requestRejection()` is unavailable or throws, the plugin **refuses to mount** rather than publishing an unauthenticated route

### Notes
- Path 1 (`connection.rpc.handle`) is still preferred: it keeps route ownership, request validation, and withdrawal with the framework. The fallback exists only for hosts where path 1 is broken.
- When DSH fixes the upstream `inject` mismatch, path 1 succeeds again and the fallback goes unused — no plugin change required.
- Verified on: DSH `0.1.5-rc.3` (client-connection 0.1.5-rc.3, host-webserver 0.1.5-rc.3), Cordis 4.0.2, Node 24.21.0. Test totals: 19 + 61 + 70 + 77 + 73 = **300 assertions**, plus 31 in `tools/verify-install.mjs` and 19 in `tools/verify-live-route.mjs`. Producer: **deepseek-v4.1-flash**.

## [0.2.0] - 2026-09-13

### Added
- **Live status panel** in the settings card: request/granted/rejected/timeout/aborted counters, average wait, per-model progress bars (token balance or window occupancy), concurrency and queue badges, and a rolling event log
- **`connection.rpc` status channel** at `/llm-rate-limiter` with `snapshot` and `reset` endpoints — the framework supplies POST+JSON transport, the Host/Origin fence (403) and browser authentication (401), and withdraws the channel with the plugin fiber
- **"清零" button** that zeroes all statistics and drops retained events
- `lib/status-rpc.js` — channel handler and envelope helpers (`success` / `failure`)
- `test-status-rpc.mjs` (61 assertions): envelopes, endpoint routing, JSON-safety, ring-buffer bounds, every counter path
- `test-client-bundle.mjs` (70 assertions): loads the real client bundle in a VM and mounts the card and panel on a miniature React runtime — covers live rendering, collapse-stops-polling, and every degraded phase

### Changed
- `dsh.client.inject` now also requires `@deepseek-ai/dsh-client-connection`, so the connection service is available before the panel mounts
- `dsh.compatibility.dshReleases` declares the verified DSH release (aligned with dsh-context's convention)
- CI runs the two new suites and syntax-checks `lib/status-rpc.js`

### Notes
- The status channel is optional: on a host without a connection service it is never registered and the panel shows "状态通道不可用" instead, leaving configuration untouched
- Statistics are in-memory only and reset when the host restarts

## [0.1.1] - 2026-09-12

### Changed
- **Package renamed to `@leaf233/dsh-llm-rate-limiter`** (npm scope) and published to npm; the internal plugin identity (`llm-rate-limiter`), settings namespace, and runtime behavior are unchanged
- `cordis.patch.yml` `name` and the browser client bundle id now follow the scoped package name (required by DSH module resolution)
- npm badge and npm install instructions added to README

### Fixed (since the `v0.1.0` git tag)
- CI: `pnpm/action-setup` now precedes `actions/setup-node` (pnpm was missing from PATH)
- CI: `pnpm-lock.yaml` committed, so `--frozen-lockfile` installs work
- Removed private `@deepseek-ai/dsh-llm` from `peerDependencies` (unresolvable for consumers)

## [0.1.0] - 2026-09-12

### Added
- Token Bucket strategy with configurable `burstSize`, `refillRate`, `maxConcurrent`
- Sliding Window strategy with `windowMs`, `maxRpm`, `maxConcurrent`
- Per-model rate limit overrides (`models["provider/model"]`)
- Queue mode: throttled requests wait and are released when slots open
- Reject mode: throttled requests fail with `RATE_LIMIT` code (compatible with `dsh-llm-retry`)
- Interactive GUI in DSH Settings → Plugins (collapsible PluginCard)
- `maxRpm` → `refillRate` auto-derivation for token-bucket when only `maxRpm` is set
- Hot-reload: settings changes take effect immediately
- `maxQueueWaitMs` timeout for queue mode
- 19 unit tests covering concurrency, burst, queue, abort, and hot-reload
- E2E test (`test-3rpm.mjs`) verifying 3 rpm limit
- DSH version compatibility analysis (COMPATIBILITY.md)
