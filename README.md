# dsh-llm-rate-limiter

[![npm](https://img.shields.io/npm/v/@leaf233/dsh-llm-rate-limiter.svg)](https://www.npmjs.com/package/@leaf233/dsh-llm-rate-limiter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH 0.1.x](https://img.shields.io/badge/DSH-0.1.x-brightgreen.svg)](COMPATIBILITY.md)
[![Cordis 4.x](https://img.shields.io/badge/Cordis-%3E%3D4.0.2-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-19%2F19%20passing-brightgreen.svg)](test-strategies.mjs)

Per-model LLM call rate limiter for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) with queue/reject support and interactive GUI configuration.

---

## Features

- **Per-model rate limiting** — independent concurrency, RPM, and burst limits for each `provider/model`
- **Two algorithms** — Token Bucket (allows bursts) or Sliding Window (smooth, strict RPM)
- **Queue mode** — throttled requests wait in queue and are released when a slot opens
- **Reject mode** — throttled requests fail immediately (integrates with `dsh-llm-retry` for auto-backoff)
- **Interactive GUI** — collapsible card in DSH Settings → Plugins → Configurable
- **Live status panel** — real-time counters, per-model progress bars and an event log (v0.2.0)
- **Hot-reload** — settings changes take effect immediately, no restart needed
- **Every request checked** — intercepts `llm/stream` waterfall, covering every LLM call in every agent turn

---

## Status Panel (v0.2.0)

Expanding the card shows a live panel at the top of its body:

```
📊 实时状态                          ● 实时   [清零]
 请求 42 · 通过 38 · 拒绝 2 · 超时 1 · 中止 1 · 平均等待 214ms
 deepseek/deepseek-chat   [令牌桶]  ▓▓▓▓▓▓▓░░░ 7.5/10   并发 2/5   排队 1
 openai/gpt-4o            [滑动窗口] ▓▓▓▓▓▓▓▓▓▓ 3/3 rpm  并发 1/5
 12:00:03  timeout   openai/gpt-4o              等待 1m
 12:00:01  rejected  openai/gpt-4o
 12:00:00  granted   deepseek/deepseek-chat     等待 4.2s
```

| Aspect | Behaviour |
|--------|-----------|
| Data channel | Framework `connection.rpc` channel `/llm-rate-limiter` — authenticated (401/403 fence), POST+JSON, auto-cleaned with the plugin fiber |
| Cadence | 1 s polling while the card is expanded; backs off 2 s → 4 s → 8 s after failures |
| Collapsed card | The panel unmounts, so **no polling runs at all** |
| Endpoints | `snapshot` (live counters) and `reset` (zero the statistics) |
| Without a channel | Shows "状态通道不可用" and leaves the rest of the card fully functional |
| Counters | `requests` / `granted` / `rejected` / `timeouts` / `aborted` / `totalWaitMs`, plus the last 8 events (ring buffer of 64) |
| Progress bars | Token bucket shows `tokens/burstSize`; sliding window shows `countInWindow/maxRpm`; both turn amber as the limit approaches |

> 🧠 **From Hindsight memory (dsh-context-host-client)** — the channel idiom is dsh-context's: `ctx.inject(["connection"])` → `conn.rpc.handle(channel, handler)`, with the browser side resolving `ctx.get("connection")?.rpc.call` defensively so a missing service degrades instead of throwing.


---

## Installation

### Option 1: npm (recommended)

```bash
dsh plugin add <your-profile> @leaf233/dsh-llm-rate-limiter
# or, inside the profile directory:
pnpm add @leaf233/dsh-llm-rate-limiter
```

### Option 2: local path (development)

```bash
dsh plugin add <your-profile> ./path/to/dsh-llm-rate-limiter
# or
dsh plugin add ./path/to/dsh-llm-rate-limiter   # default profile
```

> The plugin must be added as a dependency in the profile's `package.json`.
> The bundle entry (`cordis.patch.yml`) is auto-detected by `reconcilePlugins`.

### Option 3: from GitHub

```bash
dsh plugin add <your-profile> github:Leafyezi233/dsh-llm-rate-limiter
```

> ⚠️ **Important**: Git-hosted plugins are blocked by pnpm's `allowBuilds` restriction on first install. If the install fails, check the error message for the exact key pnpm suggests, then add it to your profile's `pnpm-workspace.yaml`:
>
> ```yaml
> pnpm:
>   allowBuilds:
>     - '@leaf233/dsh-llm-rate-limiter'
> ```
>
> Then re-run the install command.

---

## Configuration

### Via GUI

1. Open DSH Web UI (`dsh web`)
2. Go to **Settings → Plugins**
3. Find **⚙ LLM 调用限速** card — click to expand
4. Configure defaults, per-model overrides, and throttle behavior

### Via file

Edit the profile's `settings.yaml` or use the GUI — changes are persisted to the DSH settings store:

```yaml
llm-rate-limiter:
  enabled: true
  strategy: token-bucket       # "token-bucket" | "sliding-window"
  defaults:
    maxConcurrent: 5
    maxRpm: 60
    burstSize: 10               # token-bucket only
    refillRate: 1               # token-bucket only (tokens/sec)
  models:
    "deepseek/deepseek-chat":
      maxConcurrent: 8
      maxRpm: 120
    "openai/gpt-4o":
      maxConcurrent: 2
      maxRpm: 10
      burstSize: 3
    "anthropic/claude-3-5-sonnet":
      enabled: false            # skip rate limiting for this model
  onThrottled: queue            # "queue" | "reject"
  maxQueueWaitMs: 60000
```

---

## Settings Reference

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Global on/off switch. When off, zero overhead bypass. |
| `strategy` | `"token-bucket"` | `"token-bucket"` (allows bursts) or `"sliding-window"` (smooth, strict RPM) |
| `defaults.maxConcurrent` | `5` | Max simultaneous requests per model |
| `defaults.maxRpm` | `60` | Max requests per minute per model |
| `defaults.burstSize` | `10` | Token bucket capacity — how many requests can burst at once |
| `defaults.refillRate` | `1` | Tokens refilled per second (token-bucket). Auto-derived from `maxRpm / 60` if not set. |
| `models.<key>.maxConcurrent` | — | Per-model concurrency override |
| `models.<key>.maxRpm` | — | Per-model RPM override |
| `models.<key>.burstSize` | — | Per-model burst capacity override |
| `models.<key>.refillRate` | — | Per-model refill rate override |
| `models.<key>.enabled` | — | Set `false` to skip rate limiting for this specific model |
| `onThrottled` | `"queue"` | What happens when a request hits the limit: `"queue"` (wait) or `"reject"` (fail immediately) |
| `maxQueueWaitMs` | `60000` | Max time (ms) a request waits in queue before being rejected |

> **Note:** When a model overrides `maxRpm` without explicitly setting `refillRate`, the refill rate is automatically derived as `maxRpm / 60` (tokens per second). This ensures "set maxRpm=3" actually limits to 3 requests per minute.

---

## Algorithm Comparison

| | Token Bucket | Sliding Window |
|---|---|---|
| **Burst** | Yes (controlled by `burstSize`) | No — strictly smooth |
| **Recovery** | Tokens refill at `refillRate`/sec | Window slides continuously |
| **Best for** | Tolerating request spikes | APIs with hard per-minute limits |
| **GUI label** | 令牌桶 (Token Bucket) | 滑动窗口 (Sliding Window) |

---

## How It Works

```
Agent Turn
  → LLM Call (e.g. deepseek/deepseek-chat)
    → ctx.on("llm/stream") interceptor
      → Resolve rate limiter for this provider/model
      → Token bucket: has tokens + concurrency room?
      → If YES: consume token, acquire slot, forward to API
      → If NO (reject mode): return RATE_LIMIT error immediately
      → If NO (queue mode): park in waiters[], wait for token refill
    → Request completes → release slot → drain waiting requests
  → dsh-llm-retry catches RATE_LIMIT → exponential backoff → retry
```

---

## Development

```bash
# Clone
git clone https://github.com/Leafyezi233/dsh-llm-rate-limiter.git
cd dsh-llm-rate-limiter

# Install deps
pnpm install

# Run tests (19 tests)
node test-strategies.mjs

# Run E2E rate-limit test
node test-3rpm.mjs

# Install into a DSH profile for testing
dsh plugin add <your-profile> .
```

The plugin uses a live symlink when installed via `link:` — edits to `lib/` take effect on browser hard-refresh (`Ctrl+Shift+R`) without reinstalling.

---

## Compatibility

| DSH Version | Status | Notes |
|-------------|--------|-------|
| 0.1.x (RC) | ✅ Tested | Verified against 0.1.2-rc.1, cordis 4.0.2 |
| 0.2.x | ⚠️ Untested | May need API adjustments |
| Cordis 5+ | ⚠️ Untested | Major version change likely requires rewrite |

See [COMPATIBILITY.md](COMPATIBILITY.md) for detailed API dependency analysis.

---

## License

[MIT](LICENSE)
