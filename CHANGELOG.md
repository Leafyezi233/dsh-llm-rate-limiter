# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
