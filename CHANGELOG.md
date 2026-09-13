# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
