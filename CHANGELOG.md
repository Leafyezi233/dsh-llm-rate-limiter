# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
