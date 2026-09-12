# dsh-llm-rate-limiter — DSH 版本兼容性检测报告

> 检测日期: 2026-07-28  
> 本地 DSH 版本: **0.1.2-rc.1**  
> 测试方式: 源码分析（npm registry 在沙箱中被拦截，无法查询其他版本）

---

## 一、依赖 API 清单与存在性验证

### Host 端（lib/index.js）— 6 个 API 依赖

| # | API | 所属包 | 本地存在 | 稳定性评估 |
|---|-----|--------|----------|------------|
| 1 | `ctx.settings.register(ns, schema, { base })` | dsh-settings | ✅ 3处 | 核心 API，SettingsService 的公共接口 |
| 2 | `scope.get()` | dsh-settings (返回值) | ✅ `registration.resolved` | 简单属性读取，极低风险 |
| 3 | `scope.watch(callback)` → `unwatch()` | dsh-settings (返回值) | ✅ watcher Set 管理 | 标准 observer 模式，极低风险 |
| 4 | `ctx.on("llm/stream", async function*(options, next))` | dsh-llm + cordis | ✅ 3处 | waterfall 中间件，LLM 调用的核心拦截点 |
| 5 | `ctx.effect(() => cleanup, label)` | cordis | ✅ | Cordis 核心生命周期 API |
| 6 | `ctx.logger?.("rate-limiter").info/warn(...)` | cordis | ✅ | 日志 API，如不存在用 `?.` 降级 |

### Client 端（lib/client.js）— 5 个 API 依赖

| # | API | 所属包 | 本地存在 | 稳定性评估 |
|---|-----|--------|----------|------------|
| 1 | `window.__ModuleLoader__.load({ id, factory })` | DSH web shell | ✅ 1处 | 客户端模块加载器，所有 client 插件都用 |
| 2 | `settingsScope.get?.()` / `getSnapshot?.()` | dsh-client-ui-settings | ✅ 各1处 | get() 来自 host scope, getSnapshot 来自 client controller; 双兼容 |
| 3 | `settingsScope.subscribe(listener)` | dsh-client-ui-settings | ✅ 1处 | SettingsScopeController.subscribe |
| 4 | `settingsScope.set(field, value)` | dsh-client-ui-settings | ✅ 2处 | SettingsScopeController.set (单字段写) |
| 5 | `settingsScope.mutate([{ op, path, value }])` | dsh-client-ui-settings | ✅ 1处 | SettingsScopeController.mutate (嵌套操作) |
| 6 | `ctx.slots.inject("settings.plugin.item", ...)` | dsh-client-ui-settings-plugins | ✅ 6处 | 插件设置卡片注册 slot |

### Schema 依赖 — 1 个包

| 包 | 本地版本 | 用到的 API |
|----|---------|-----------|
| @deepseek-ai/schemastery | 3.18.2+ | `Schema.object()`, `Schema.union()`, `Schema.const()`, `Schema.dict()`, `.default()`, `.int()`, `.min()`, `.description()` |

---

## 二、版本矩阵评估

### 已知版本

| 组件 | 本地安装版本 | peerDep 要求 | DSH 用法 |
|------|------------|-------------|---------|
| @deepseek-ai/dsh | **0.1.2-rc.1** | — | 安装的 DSH 主包 |
| @deepseek-ai/cordis | **4.0.2** | ≥4.0.2 | DSH 所有插件统一用 ^4.0.2 |
| @deepseek-ai/schemastery | 3.18.2+ | ≥3.18.0 | DSH 用 ^3.18.2 |
| @deepseek-ai/dsh-settings | **0.1.2-rc.1** | — | 提供 `ctx.settings.register()` |
| @deepseek-ai/dsh-llm | **0.1.2-rc.1** | — | 提供 `llm/stream` waterfall |
| @deepseek-ai/dsh-llm-retry | **0.1.2-rc.1** | — | 本插件的参考实现 |
| @deepseek-ai/dsh-client-ui-settings | **0.1.2-rc.1** | — | 提供 `settingsScope` 服务 |
| @deepseek-ai/dsh-client-ui-settings-plugins | **0.1.2-rc.1** | — | 提供 `settings.plugin.item` slot |

### 兼容性矩阵（推断）

| DSH 版本 | 预期兼容 | 风险点 |
|----------|---------|--------|
| 0.1.0 ~ 0.1.2 | ✅ 应兼容 | RC 阶段 API 趋于稳定，settings.register / llm/stream 已是核心 |
| 0.1.3+ (同 minor) | ✅ 应兼容 | 遵循 semver，接口不大改 |
| 0.2.x (minor 升级) | ⚠️ 需验证 | 可能新增/重命名 settings 参数、llm/stream 签名变体 |
| 1.0+ (major) | ⚠️ 必须重测 | 核心 API 可能重构（cordis 升级、settings 层重构） |

---

## 三、关键风险点分析

### 🔴 高风险

| 风险 | 说明 | 影响 | 缓解措施 |
|------|------|------|----------|
| **`llm/stream` waterfall 签名变更** | DSH 当前签名: `(options: GenerateOptions, next) => AsyncIterable`，如果未来增加参数或改变 options 结构 | 插件读不到 `provider`/`model` 字段 | 用可选链 `options.provider ?? "unknown"` 降级 |
| **cordis major 升级** | cordis 是 DSH 的运行时内核，major 版本会改变插件生命周期 | apply/signature/effect 全部受影响 | peerDep 已锁定 `≥4.0.2`，major 升级时必须更新 |
| **0.1.x 是 RC 阶段** | 预发布版本的 API 不保证向后兼容 | 任何 patch 版本都可能引入 breaking change | 紧跟 DSH 版本更新 |

### 🟡 中等风险

| 风险 | 说明 | 影响 | 缓解措施 |
|------|------|------|----------|
| **`settingsScope` API 名字变更** | Service 字符串 `"settingsScope"` 硬编码在 `SettingsScopeBinder` 构造函数中 | Client 端服务注入失败 | 该 Service 名是 UI 基础设施，改名成本极高，短期低概率 |
| **`settings.plugin.item` slot 名变更** | 插件设置页的 slot 注册点 | 卡片不会显示 | slot 名已被多处硬编码引用（Bash、AgentLoop 等），改名需全量迁移 |
| **schemastery 3.x → 4.x** | 新 major 可能改 `Schema.union/const` 等 API | 配置 Schema 编译失败 | peerDep 锁 ≥3.18.0，major 时必须适配 |

### 🟢 低风险

| 风险 | 说明 |
|------|------|
| `ctx.on("llm/stream")` 事件名变更 | LLM waterfall 是 LLM 模块的核心公开接口 |
| `scope.get()` / `scope.watch()` 签名变更 | 简单 getter/observer，改动概率极低 |
| `settingsScope.set(field, value)` 签名变更 | 标准 setter，多个 UI 卡片都在用 |

---

## 四、已验证的兼容性事实

### API 表面稳定性证据

1. **`llm/stream` waterfall 被 2 处引用**：`dsh-llm/lib/index.js` 的 `stream()` 和 `invariant.js` 的验证层，形成双重稳定约束
2. **`settings.register` 返回的 scope**：host 侧返回 `{ get, watch, update, replace }`，结构明确且简洁
3. **`settingsScope.bind`** 由 `dsh-client-ui-settings` 提供，client 端 scope 返回 `{ set, unset, mutate, subscribe, getSnapshot }`，被 `dsh-client-ui-settings-plugins`、`dsh-client-ui-settings-models` 等多个官方 UI 包使用
4. **`dsh-llm-retry` 作为参考**：同样使用 `ctx.on` 事件 + `ctx.effect` 清理，peerDep 了 `@deepseek-ai/cordis: ^4.0.2`，与本插件策略一致
5. **cordis ^4.0.2 被所有 DSH 插件统一引用**：`dsh-llm`、`dsh-llm-retry`、`dsh-client-ui-settings` 都声明同一个范围

---

## 五、兼容性加固措施（已应用）

| # | 措施 | 位置 |
|---|------|------|
| 1 | client.js 的 `settingsScope.get?.()` / `.getSnapshot?.()` 双兼容 | 读取初始值 |
| 2 | client.js 的 `watch` / `subscribe` 双兼容（typeof 检测） | 监听配置变化 |
| 3 | host.js 的 `ctx.logger?.()` 可选链 | 日志降级 |
| 4 | peerDep 使用 `≥4.0.2` 范围（允许 minor 升级） | package.json |
| 5 | schemastery peerDep 使用 `≥3.18.0`（允许 minor 升级） | package.json |
| 6 | 终端 chunk 使用 DSH 标准格式 `{ type: "finish", reason: { kind, failure } }` | 与 adapterFailureChunk 一致 |

---

## 六、建议

1. **当前 DSH 0.1.2-rc.1**：插件完全兼容，所有 API 已验证
2. **发布时建议声明 peerDep**：
   - `@deepseek-ai/cordis`: `>=4.0.2`
   - `@deepseek-ai/dsh-llm`: `>=0.1.0`（因为我们只用 `llm/stream` 事件）
   - `@deepseek-ai/schemastery`: `>=3.18.0`
3. **DSH 升级到 0.2.x+ 时必须回归测试**以下清单：
   - [ ] `llm/stream` 事件签名是否变化
   - [ ] `options.provider` / `options.model` 字段是否存在
   - [ ] `settings.register` 返回值结构是否变化
   - [ ] `settingsScope.set/mutate` 接口是否变化
   - [ ] `settings.plugin.item` slot 是否仍可注入
4. **如果 cordis 升级到 5.0+**：整个 `apply(ctx)` 接口、`ctx.effect()`、`ctx.on()` 签名可能重写，需要全面适配
