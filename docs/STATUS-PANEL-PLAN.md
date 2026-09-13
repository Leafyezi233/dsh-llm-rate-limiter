# 状态面板（Status Panel）设计方案 v2 — 基于 dsh-context 范式

> 为 dsh-llm-rate-limiter 新增实时状态面板。v2 依据本机 dsh-context v0.50.0
>（成熟第三方 dashboard 插件）的架构分析与记忆库调研，**弃用 v1 的 webServer+SSE 通道**，
> 改用框架级 `connection.rpc` 通道 + 客户端轮询。

---

## 0. v1 → v2 变更摘要

| 项 | v1（已废弃） | v2（本方案） | 变更原因 |
|----|---------------|--------------|----------|
| 数据通道 | `webServer.register()` 自建 SSE + JSON 路由 | **`connection.rpc.handle("/llm-rate-limiter", …)`** | dsh-context 证明这是第三方插件标准通道；框架自带认证/传输/fiber 清理，代码量减半 |
| 实时性 | SSE 服务器推送（事件即时） | **面板打开时 1s 轮询**（DetailStore 式退避） | DSH 无第三方可用的通用推送管道；仪表盘 1s 粒度足够 |
| 认证 | 无（裸路由，0.0.0.0 时局域网可读） | **框架级**：Host/Origin fence(403) + browser auth(401) | `HostConnectionService.requestRejection` 自动应用，安全面收窄 |
| 事件回放 | SSE `history`/`event` 帧流 | **events 数组随 snapshot 返回**（末 8 条 + rev 游标） | 单端点化，协议从 3 帧型减为 2 端点 |
| 调试端点 | 独立 GET JSON 路由（curl 可用） | 移除（面板即调试界面） | 避免维护第二条无认证路由 |
| UI 形态 | 卡片内折叠节 | 不变 | — |
| 兼容声明 | 无 | **`dsh.compatibility.dshReleases`**（对齐 dsh-context） | 成熟插件物料约定 |

---

## 1. dsh-context 结构分析（v2 依据）

> 🧠 **From Hindsight memory (dsh-context-host-client)** — dsh-context 用 session projection
> 推送会话级数据、用 `connection.rpc.handle("/dsh-context")` 做按需读取、客户端以
> `rpcCallOf` 反射读取 `ctx.get("connection")?.rpc.call` 并用 DetailStore 单飞行+退避模式轮询；
> 通用 RPC 通道仅 POST JSON，注册挂 owner.effect 自动清理，`/api` 为保留通道名。

### 1.1 它的数据面（三层，按数据归属选择）

| 层 | 机制 | 适用 | 限速器可用？ |
|----|------|------|--------------|
| ① Session Projection | `ctx.sessionProjections.register({key, stateSchema, wire, init, apply, stateVersion})`，框架 fold+缓存+推送，客户端 `useProjection()` | **会话级**状态（每个 session 的上下文构成） | ❌ 限速器状态是 **Host 全局**的，不属于任何单 session |
| ② Connection RPC | Host `ctx.inject(["connection"])` → `conn.rpc.handle(channel, handler)`；Client `rpcCallOf(ctx)` 反射读取 `rpc.call` | **按需请求/响应**（dsh-context 的 detail 通道） | ✅ **本方案通道** |
| ③ 官方 Remote（Typert） | `remote.<ns>` 生成式挂载 | 官方服务间调用 | ❌ README 明言 Client 侧只能挂载严格模式生成的贡献项，第三方无法注册自己的 endpoint |

**关键事实（源码验证）**：
- `HostConnectionService`（dsh-client-connection）的 `rpc.handle(channel, handler)` 是**公开通用 API**：在 webServer 上注册 prefix 路由，自动套 `requestRejection`（Host/Origin 不信任→403，浏览器未认证→401）；
- 通道名规则 `/^\/[A-Za-z0-9._~-]+$/`，`/api` 保留——`/llm-rate-limiter` 合法；
- wire 契约：仅 POST + `application/json`；handler `(endpoint, payload, signal) => envelope`，envelope 为 `{ok:true, value}` 或 `{ok:false, error:{code, message, details:{}}}`（dsh-context 的 `failure()` 工具逐字复制即可）；
- 注册挂在 `owner.effect` 上——**插件卸载自动撤通道**，无需手工清理连接集；
- DSH **没有**第三方可用的通用推送（`rpc.open` 流仅 /api/Typert 网关，`$events` 生成式专属）→ "实时"= 客户端轮询，这正是 dsh-context DetailStore 的做法。

### 1.2 它的客户端防御范式（直接效仿）

```js
// rpcCallOf：反射读取，服务缺席/敌意/热重载时降级 undefined，绝不 throw
function rpcCallOf(ctx) {
  try {
    const rpc = ctx.get("connection")?.rpc;
    const fn = rpc?.call;
    if (rpc && typeof fn === "function") return fn.bind(rpc);
  } catch {}
}
```
- 模块级 `inject` 只声明基座（dsh-context：`["slots","locale"]`）；connection 等**不进**模块 inject——服务缺席时 UI 降级（显示"通道不可用"）而不是整个卡片不加载；
- package.json 的 `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-connection`（bundle 依赖声明，确保连接服务先于本插件可用）。

### 1.3 DetailStore 轮询模式（客户端实时读取范式）

单飞行互斥 + 失败指数退避（base×2ⁿ，n≤3）+ 成功保留最后好值 + 关闭视图即停。v2 将其简化为 8 行轮询循环（见 §6.2）。

---

## 2. 记忆库输入（方案对齐点）

- **插件 initiative 页**（kp-2696ff…）：现有架构（waterfall 拦截、双策略 `getStatus()` 已就绪、settings 动态注入防御）——v2 完全复用，策略层零改动；
- **CI 经验文档**（dsh-ci-pnpm-lock…）：lockfile 必须入库、action 顺序——本次仅追加测试文件，不影响 CI 结构；
- **dsh-context 研究文档**（本session入库 `dsh-context-host-client`）：通道选型、防御范式、compatibility 声明约定——即 §1；
- 记忆库后台仍在深描（Conventions/Key decisions 页面生成中），不影响本方案；实施前如需可再读。

---

## 3. 总体架构（v2）

```
┌─ Host (Node) ─────────────────────────────────────────────────────┐
│ llm/stream 拦截器（现有，不动骨架）                                  │
│   ├─ 埋点: totals 计数器 + rev 游标 + 事件环形缓冲(64)               │
│   └─ limiters: Map<model, Strategy>（getStatus() 零改动）            │
│              │                                                      │
│              ▼                                                      │
│        buildSnapshot()  ←—— resetTotals()                          │
│              │                                                      │
│   ctx.inject(["connection"])                                       │
│     conn.rpc.handle("/llm-rate-limiter", handler)                  │
│       ├─ endpoint "snapshot" → {ok:true, value: 快照}              │
│       └─ endpoint "reset"    → 清零统计                             │
│              │  框架自动: POST-JSON + 403/401 fence + fiber 清理    │
└──────────────┼───────────────────────────────────────────────────────┘
               ▼ 同源 /llm-rate-limiter/snapshot（POST）
┌─ Client (browser) ─────────────────────────────────────────────────┐
│ RateLimiterCard（现有可折叠卡片，body 顶部新增第一节）                │
│  └─ RateLimiterStatus                                               │
│      ├─ 打开时: rpcCallOf(ctx) → 1s 轮询 snapshot（失败退避至 8s）  │
│      ├─ chips: 请求/通过/排队/拒绝/平均等待 + [清零] 按钮            │
│      ├─ 每模型行: 进度条 + 并发 n/n + 排队徽标                      │
│      └─ 最近事件日志(8条)                                            │
└────────────────────────────────────────────────────────────────────┘
```

生命周期与降级：
- **折叠 = 不轮询**（useEffect 随 open 卸载，断开一切定时器）；
- connection 服务缺席（老版本 DSH / 非 web 组合）：显示"状态通道不可用"，其余卡片功能不受影响；
- Host 端无 connection 时 `ctx.inject` 回调不运行——与现有 settings 注入同款防御，纯 CLI 组合零影响。

---

## 4. 协议规范

### 4.1 通道与端点

| 方法 | 路径 | payload | 响应 |
|------|------|---------|------|
| POST | `/llm-rate-limiter/snapshot` | `{}` | `{ok:true, value: Snapshot}` |
| POST | `/llm-rate-limiter/reset` | `{}` | `{ok:true, value:{}}`（totals 清零、rev++） |
| POST | 其它 endpoint | 任意 | `{ok:false, error:{code:"llm-rate-limiter/unknown-endpoint", …}}` |

> 通道名 `/llm-rate-limiter` 通过 `assertChannel` 校验（`/^\/[A-Za-z0-9._~-]+$/`，非 `/api`）；框架强制 POST + JSON + 认证，无需自建任何路由。

### 4.2 Snapshot 结构

```json
{
  "rev": 1064,
  "ts": 1760000000000,
  "enabled": true,
  "strategy": "token-bucket",
  "onThrottled": "queue",
  "totals": {
    "requests": 42, "granted": 38, "rejected": 1,
    "timeouts": 0, "aborted": 3, "totalWaitMs": 8123
  },
  "models": {
    "deepseek/deepseek-chat": {
      "strategy": "token-bucket",
      "tokens": 7.5, "burstSize": 10, "refillRate": 0.5,
      "concurrent": 2, "maxConcurrent": 5, "queued": 1
    }
  },
  "events": [
    { "event": "granted", "model": "deepseek/deepseek-chat", "waitMs": 4210, "ts": 1760000000000 }
  ]
}
```
- `models[key]`：与两策略现有 `getStatus()` 输出**逐字段一致**——策略类零改动；
- `events`：环形缓冲末 8 条（缓冲上限 64，防内存增长）；
- `rev`：每次 recordEvent 时递增——客户端用它检测"两次轮询之间有新事件"（对事件行做短暂高亮），未来也可做增量协议的游标。

---

## 5. Host 端改动

### 5.1 新文件 `lib/status-rpc.js`（~40 行）

```js
/** The status RPC channel over connection.rpc (the dsh-context detail-channel idiom). */
const CHANNEL = "/llm-rate-limiter";

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

export function createStatusChannel({ buildSnapshot, resetTotals }) {
  return async function handler(endpoint) {
    if (endpoint === "snapshot") return { ok: true, value: buildSnapshot() };
    if (endpoint === "reset")    { resetTotals(); return { ok: true, value: {} }; }
    return fail("llm-rate-limiter/unknown-endpoint", `unknown endpoint: ${endpoint}`);
  };
}
export { CHANNEL };
```

### 5.2 `lib/index.js` 改动点

```js
import { createStatusChannel, CHANNEL } from "./status-rpc.js";

// ① 统计与事件（apply 顶部）
const totals = { requests:0, granted:0, rejected:0, timeouts:0, aborted:0, totalWaitMs:0 };
let rev = 0;
const eventRing = [];
function recordEvent(ev) {
  eventRing.push({ ...ev, ts: Date.now() });
  if (eventRing.length > 64) eventRing.shift();
  rev++;
}
function buildSnapshot() {
  const models = {};
  for (const [key, limiter] of limiters) models[key] = limiter.getStatus();
  return { rev, ts: Date.now(), enabled: cfg.enabled, strategy: cfg.strategy,
           onThrottled: cfg.onThrottled, totals, models, events: eventRing.slice(-8) };
}
function resetTotals() {
  for (const k of Object.keys(totals)) totals[k] = 0;
  eventRing.length = 0; rev++;
}

// ② 通道挂载（与 settings 注入并列；fiber 级自动清理）
ctx.inject(["connection"], (c) => {
  const conn = c.get("connection");
  const handle = typeof conn?.rpc?.handle === "function" ? conn.rpc.handle.bind(conn.rpc) : undefined;
  if (handle === undefined) return;                       // 老 Host：静默降级
  c.effect(() => {
    const unregister = handle(CHANNEL, createStatusChannel({ buildSnapshot, resetTotals }));
    return () => { unregister(); };
  }, "llm-rate-limiter: status rpc channel");
});

// ③ 拦截器埋点（各一行，位置对应现有代码路径）
//    acquire 前:            totals.requests++
//    granted 后:            totals.granted++; totals.totalWaitMs += permit.waitMs ?? 0;
//                          recordEvent({ event:"granted", model: modelKey, waitMs: permit.waitMs })
//    reject 拒绝:           totals.rejected++; recordEvent({ event:"rejected",  model: modelKey })
//    queue 超时:            totals.timeouts++; recordEvent({ event:"timeout",   model: modelKey, waitMs: permit.waitMs })
//    signal 中止:           totals.aborted++;  recordEvent({ event:"aborted",   model: modelKey })
//    finally(releaseSlot 前): recordEvent({ event:"completed", model: modelKey })
```

> 策略类 `token-bucket.js` / `sliding-window.js` **零改动**；v1 的 `status-bus.js`（SSE 连接集、心跳、EPIPE 处理）**不再需要**。

---

## 6. Client 端改动

### 6.1 package.json

```json
"dsh": {
  "client": { "inject": ["@deepseek-ai/dsh-client-connection",      // ← 新增
                        "@deepseek-ai/dsh-client-ui-settings"] },
  "compatibility": { "dshReleases": { "0.1.2-rc.1": "compatible" } } // ← 新增，对齐 dsh-context
}
```

### 6.2 `lib/client.js`

**① rpcCallOf（dsh-context 同款防御反射）+ 懒绑定 prop**
```js
function rpcCallOf(ctx) {
  try {
    const rpc = ctx.get("connection")?.rpc;
    const fn = rpc?.call;
    if (rpc && typeof fn === "function") return fn.bind(rpc);
  } catch {}
}
// apply(ctx) 内注册 slot 时追加 prop（每次调用时反射，HMR/服务落地均安全）：
inject: () => ({ settingsScope: scope, statusCall: () => rpcCallOf(ctx) })
```

**② RateLimiterStatus 组件（轮询 + 退避，DetailStore 简化版）**
```js
function RateLimiterStatus({ statusCall }) {
  const [snap, setSnap] = react.useState(null);
  const [phase, setPhase] = react.useState("connecting"); // connecting | live | failed | no-channel

  react.useEffect(() => {
    const call = statusCall();
    if (call === undefined) { setPhase("no-channel"); return; }   // 折叠面板无此组件，此处 = 服务缺席
    let stop = false, timer = null, failures = 0;
    const tick = async () => {
      try {
        const r = await call("/llm-rate-limiter", "snapshot", {});
        if (stop) return;
        if (r?.ok !== true || !r.value) throw new Error("bad envelope");
        setSnap(r.value); setPhase("live"); failures = 0;
      } catch {
        if (!stop) { failures++; setPhase("failed"); }
      }
      if (!stop) timer = setTimeout(tick, 1000 * 2 ** Math.min(failures, 3)); // 1s→2s→4s→8s
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };  // 折叠即停
  }, [statusCall]);

  // 渲染分相：no-channel→"状态通道不可用（需要 DSH web 组合）"；
  //          failed→"连接中断，重试中…"（保留最后好值）；live→面板
  // …chips / 模型行 / 事件日志 / [清零] 按钮（POST reset 成功后立刻 tick 一次）
}
```

**③ UI 布局**（卡片 body 第一节，"默认配置"之前；CSS 追加 `.rlr-chip/.rlr-chipWarn/.rlr-chipErr/.rlr-statusBar/.rlr-statusFill/.rlr-badge/.rlr-log/.rlr-logRow`）：

```
📊 实时状态                                    [↻ 刷新] [清零]
 请求 42 · 通过 38 · 排队 1 · 拒绝 1 · 平均等待 2.0s      ← chips（等宽数字）
─────────────────────────────────────────────────────
 deepseek/deepseek-chat                    [令牌桶]
 ▓▓▓▓▓▓▓░░░ 7.5/10     并发 2/5   排队 1 ⏳
 openai/gpt-4o                            [滑动窗口]
 ▓▓▓░░░░░░░ 3/3 rpm     并发 1/5
─────────────────────────────────────────────────────
 12:00:03  granted   deepseek/deepseek-chat  (等待 4.2s)
 12:00:01  rejected  deepseek/deepseek-chat
```
- 进度条：token-bucket 用 `tokens/burstSize`；sliding-window 用 `countInWindow/maxRpm`；
- 模型行 = `cfg.models` 键 ∪ `snap.models` 键（配置了但未调用的显示灰置"未调用"）；
- `enabled === false` 时整节显示"限速已停用"；事件行在 `rev` 变化时短暂高亮；
- 全部文案暂保持中文硬编码（i18n 对齐 dsh-context 的 `locale.register` 列为 v0.3 候选）。

---

## 7. 测试计划

| 层级 | 文件 | 覆盖 |
|------|------|------|
| 单元（新增） | `test-status-rpc.mjs` | ①`snapshot` 返回 `{ok:true}` + 快照字段齐全（rev/totals/models/events） ②`reset` 清零且 rev 递增 ③未知 endpoint 返回 `{ok:false, error.code="llm-rate-limiter/unknown-endpoint"}` ④envelope 恒为 JSON-safe（无函数/循环引用）⑤recordEvent 环形缓冲 64 上限 ⑥埋点后 totals 各计数正确（fake limiter 模拟 granted/rejected/timeout/aborted） |
| 单元（回归） | `test-strategies.mjs` | 现有 19 断言不动，全绿（策略零改动，理论必过，跑一遍防意外） |
| E2E（手动） | `dsh web` + 3rpm 场景 | 面板打开→连发 4 请求→观察 rejected 出现、chips 递增、事件日志滚动；折叠面板→DevTools Network 无残留轮询；`reset` 后归零 |
| CI | `test.yml` | 追加 `node test-status-rpc.mjs` |

---

## 8. 文档与发布

| 项 | 内容 |
|----|------|
| README.md | 新增「状态面板」节：功能截图、实时性说明（1s 轮询）、清零按钮、协议端点表 |
| COMPATIBILITY.md | 依赖表新增 `connection.rpc.handle / rpc.call`（风险：低——dsh-context v0.50.0 已在 0.1.2-rc.1→0.1.5-rc.1 验证同 API）；回归清单：snapshot/reset 往返、折叠停轮询、no-channel 降级 |
| CHANGELOG.md | v0.2.0：状态面板（connection.rpc 通道、1s 轮询、事件日志、清零） |
| package.json | version 0.2.0；`dsh.client.inject` 增 connection bundle；`dsh.compatibility.dshReleases` 声明 |
| Git | commit + tag `v0.2.0` + push |

---

## 9. 风险与兼容性

| 风险 | 评估 | 缓解 |
|------|------|------|
| `connection.rpc` API 变更 | **低**：dsh-context v0.50.0 用同 API 横跨 0.1.2-rc.1→0.1.5-rc.1（其 compat 矩阵），是持久公开契约 | COMPATIBILITY.md 列回归项；`typeof handle === "function"` 双重防御 |
| Host 无 connection 服务 | 零影响：动态 inject 不激活（与 settings 同款防御） | — |
| Client connection 服务缺席/敌意 | rpcCallOf 反射降级 → 面板显示"通道不可用"，卡片其余功能照常 | dsh-context 同款范式 |
| 轮询期间通道撤除（插件热重载） | 调用 reject → phase=failed → 退避重试；通道恢复后自动接回 | DetailStore 语义 |
| 认证失败（401） | 仅发生在非法来源调用时；同源 GUI 自带认证 | 框架处理，无需代码 |
| `rev` 回退（Host 重启统计清零） | 客户端将 rev 用于高亮判断，回退无碍（不做增量协议） | — |
| 高频请求下 snapshot 体积 | ~300B/次（8 模型、8 事件上限）；1Hz×展开面板数，可忽略 | — |
| 事件在两次轮询间聚合（granted→completed <1s） | 事件行可能只看到后者；totals 不丢计数 | 可接受（仪表盘非审计日志） |

**v1 风险表中的 SSE 专项（EPIPE、心跳、多连接 Set、LAN 裸读）全部随通道更换而消失。**

---

## 10. 实施步骤（单次提交）

1. `lib/status-rpc.js` 新文件（channel handler + envelope 工具）
2. `lib/index.js`：totals/rev/eventRing + `recordEvent`/`buildSnapshot`/`resetTotals` + `ctx.inject(["connection"])` 挂载 + 拦截器 6 处埋点
3. `lib/client.js`：rpcCallOf + `statusCall` prop + `RateLimiterStatus`（轮询/退避/分相渲染/chips/进度条/事件日志/清零）+ CSS 追加
4. `package.json`：version 0.2.0 + client.inject + compatibility.dshReleases
5. `test-status-rpc.mjs` + CI 追加一行
6. `node test-strategies.mjs && node test-status-rpc.mjs && node --check lib/index.js lib/client.js` 全绿
7. `dsh web` 手动验收（§7 E2E 三项）
8. 文档三件套更新 + commit + tag `v0.2.0` + push

---

## 附：本方案引用的证据位置

| 事实 | 文件 | 行 |
|------|------|----|
| `rpc.handle` 公开 + fiber 清理 + 403/401 | dsh-client-connection/lib/index.js | 500-588 |
| 通道名规则与 /api 保留 | 同上 | 497-498, 660-661 |
| POST-JSON wire 契约 | 同上 rpcFetchHandler | 605-628 |
| 客户端 call 契约与传输失败 reject | dsh-client-connection/lib/client.js | 4596-4624 |
| dsh-context host 通道挂载范式 | dsh-context/lib/index.js | 1943-2012 |
| dsh-context envelope/unknown-endpoint 范式 | 同上 | 1925-1936, 1953 |
| rpcCallOf 防御反射 | dsh-context/lib/client.js | 1317-1323 |
| DetailStore 退避/单飞行 | 同上 | 1842-1930 |
| compatibility.dshReleases 声明 | dsh-context/package.json | 65-72 |
