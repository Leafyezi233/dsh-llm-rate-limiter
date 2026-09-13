/* eslint-disable */
/**
 * dsh-llm-rate-limiter — Client (browser) entry point.
 *
 * Registers a "Rate Limiter" card in the Plugins → Configurable settings page.
 * The card uses a collapsible header (PluginCard pattern) with a chevron toggle.
 *
 * Browser format: CJS-style factory registered via window.__ModuleLoader__.load
 * (loaded as a plain <script>, so NO top-level ESM `export` allowed).
 *
 * @module dsh-llm-rate-limiter/client
 */
window.__ModuleLoader__.load({
	id: "@leaf233/dsh-llm-rate-limiter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ── React imports (browser module system provides them) ──────────────
		let react, jsx, jsxs;
		react = require("react");
		({ jsx, jsxs } = require("react/jsx-runtime"));

		// ── Shared constants ──
		const name = "llm-rate-limiter";
		const inject = ["slots", "settingsScope"];

		/* ── CSS-in-JS (design tokens, injected once) ────────────────────── */
		(() => {
			const styles = [
				".rlr-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s;margin:0}",
				".rlr-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
				".rlr-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
				".rlr-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
				".rlr-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
				".rlr-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
				".rlr-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
				".rlr-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
				".rlr-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;font-size:12px}",
				".rlr-chevronOpen{transform:rotate(180deg)}",
				".rlr-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding:8px 0 8px}",
				".rlr-status{color:var(--dsw-alias-label-tertiary);margin:8px 0 4px;font-size:12px;line-height:1.5}",
				".rlr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0}",
				".rlr-label{min-width:140px;font-size:13px;color:var(--dsw-alias-label-secondary)}",
				".rlr-input{width:80px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-surface-s2);color:var(--dsw-alias-label-primary);font-size:13px}",
				".rlr-select{padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-surface-s2);color:var(--dsw-alias-label-primary);font-size:13px}",
				".rlr-btn{height:30px;padding:0 12px;border-radius:15px;border:none;cursor:pointer;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary-foreground);background:var(--dsh-alias-button-primary-fill,#4f46e5)}",
				".rlr-btnSec{height:26px;padding:0 10px;border-radius:13px;border:none;cursor:pointer;font-size:12px;background:var(--dsw-alias-button-secondary-fill);color:var(--dsw-alias-label-primary)}",
				".rlr-danger{height:26px;padding:0 8px;border-radius:13px;border:none;cursor:pointer;font-size:11px;background:var(--dsw-alias-state-error-primary);color:#fff}",
				".rlr-modelRow{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l4);gap:8px;margin:4px 0}",
				".rlr-modelName{font-size:13px;font-weight:500;font-family:monospace}",
				".rlr-modelMeta{display:flex;gap:12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
				".rlr-section{display:flex;flex-direction:column;gap:4px;margin-top:2px}",
				".rlr-sectHead{margin:10px 0 0;font-size:14px;font-weight:500}",
			].join("\n");
			const tagId = "@dsh-llm-rate-limiter/rate-limiter-card.css";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-llm-rate-limiter";
				tag.dataset.pluginCss = tagId;
				tag.textContent = styles;
				document.head.appendChild(tag);
			}
		})();

		/* ── helpers ─────────────────────────────────────────────────────── */
		function readNum(cfg, key, field) {
			return cfg.models?.[key]?.[field] ?? cfg.defaults?.[field] ?? 0;
		}
		function setNested(scope, path, value) {
			scope.mutate([{ op: "set", path, value }]);
		}
		function unsetNested(scope, path) {
			scope.mutate([{ op: "unset", path }]);
		}

		/* ── React component: collapsible card ───────────────────────────── */
		function RateLimiterCard({ settingsScope }) {
			const [cfg, setCfg] = react.useState(() => {
				const snap = settingsScope.getSnapshot?.();
				return snap?.status === "ready" && snap.value ? { ...snap.value } : {};
			});

			react.useEffect(() => {
				const unsub = settingsScope.subscribe?.(() => {
					const snap = settingsScope.getSnapshot();
					if (snap?.status === "ready" && snap.value) setCfg({ ...snap.value });
				});
				return () => (typeof unsub === "function" ? unsub() : undefined);
			}, [settingsScope]);

			const modelKeys = Object.keys(cfg.models ?? {});

			function addModel() {
				const key = prompt('添加模型限速 (格式: provider/model)\n例如: deepseek/deepseek-chat');
				if (!key) return;
				setNested(settingsScope, ["models", key], {});
			}
			function removeModel(key) {
				unsetNested(settingsScope, ["models", key]);
			}
			function setModelField(key, field, value) {
				const path = ["models", key, field];
				if (value === undefined || value === "") unsetNested(settingsScope, path);
				else setNested(settingsScope, path, value);
			}
			function setDefault(field, value) {
				setNested(settingsScope, ["defaults", field], value);
			}
			function setTop(field, value) {
				settingsScope.set(field, value);
			}

			const [open, setOpen] = react.useState(false);

			return jsxs("li", { className: "rlr-card" + (open ? " rlr-cardOpen" : ""), children: [
				jsxs("button", {
					type: "button",
					className: "rlr-header",
					"aria-expanded": open,
					onClick: () => setOpen(!open),
					children: [
						jsxs("span", { className: "rlr-headText", children: [
							jsx("span", { className: "rlr-name", children: "⚙ LLM 调用限速" }),
							jsx("span", { className: "rlr-description", children: "按模型限制 LLM 请求频率，超出限制的请求排队等待" }),
						] }),
						jsx("span", { className: "rlr-chevron" + (open ? " rlr-chevronOpen" : ""), children: "▾" }),
					]
				}),
				open && jsxs("div", { className: "rlr-body", children: [
					/* ── 启用开关 ── */
					jsxs("div", { className: "rlr-row", children: [
						jsx("label", { children: [
							jsx("input", { type: "checkbox", checked: cfg.enabled ?? true, onChange: (e) => setTop("enabled", e.target.checked) }),
							" 启用限速",
						] }),
					] }),
					/* ── 默认配置 ── */
					jsxs("div", { className: "rlr-section", children: [
						jsx("div", { className: "rlr-sectHead", children: "默认配置" }),
						jsxs("div", { className: "rlr-row", children: [
							jsx("span", { className: "rlr-label", children: "策略" }),
							jsxs("select", { className: "rlr-select", value: cfg.strategy ?? "token-bucket", onChange: (e) => setTop("strategy", e.target.value), children: [
								jsx("option", { value: "token-bucket", children: "令牌桶 (Token Bucket)" }),
								jsx("option", { value: "sliding-window", children: "滑动窗口 (Sliding Window)" }),
							] }),
						] }),
						jsxs("div", { className: "rlr-row", children: [
							jsx("span", { className: "rlr-label", children: "最大并发数" }),
							jsx("input", { type: "number", min: 1, className: "rlr-input", value: cfg.defaults?.maxConcurrent ?? 5, onChange: (e) => setDefault("maxConcurrent", Number(e.target.value) || 1) }),
						] }),
						jsxs("div", { className: "rlr-row", children: [
							jsx("span", { className: "rlr-label", children: "每分钟最大请求数" }),
							jsx("input", { type: "number", min: 1, className: "rlr-input", value: cfg.defaults?.maxRpm ?? 60, onChange: (e) => setDefault("maxRpm", Number(e.target.value) || 1) }),
						] }),
						cfg.strategy !== "sliding-window" && jsxs(react.Fragment, { children: [
							jsxs("div", { className: "rlr-row", children: [
								jsx("span", { className: "rlr-label", children: "突发容量" }),
								jsx("input", { type: "number", min: 1, className: "rlr-input", value: cfg.defaults?.burstSize ?? 10, onChange: (e) => setDefault("burstSize", Number(e.target.value) || 1) }),
							] }),
							jsxs("div", { className: "rlr-row", children: [
								jsx("span", { className: "rlr-label", children: "补充速率 (个/秒)" }),
								jsx("input", { type: "number", min: 0.1, step: 0.1, className: "rlr-input", value: cfg.defaults?.refillRate ?? 1, onChange: (e) => setDefault("refillRate", Number(e.target.value) || 0.1) }),
							] }),
						] }),
					] }),
					/* ── 模型专属配置 ── */
					jsxs("div", { className: "rlr-section", children: [
						jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [
							jsx("div", { className: "rlr-sectHead", children: "模型专属配置" }),
							jsx("button", { className: "rlr-btn", onClick: addModel, children: "+ 添加模型" }),
						] }),
						modelKeys.length === 0 && jsx("p", { className: "rlr-status", children: "未配置模型专属限速，所有模型使用默认值。" }),
						modelKeys.map((key) => jsxs("div", { className: "rlr-modelRow", key, children: [
							jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4, flex: 1 }, children: [
								jsx("span", { className: "rlr-modelName", children: key }),
								jsxs("div", { className: "rlr-modelMeta", children: [
									jsx("span", { children: `并发: ${readNum(cfg, key, "maxConcurrent")}` }),
									jsx("span", { children: `RPM: ${readNum(cfg, key, "maxRpm")}` }),
									cfg.strategy !== "sliding-window" && jsx("span", { children: `突发: ${readNum(cfg, key, "burstSize")}` }),
								] }),
								jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 4 }, children: [
									jsx("input", { type: "number", min: 1, className: "rlr-input", style: { width: 60 }, title: "并发", placeholder: "并发", value: cfg.models?.[key]?.maxConcurrent ?? "", onChange: (e) => setModelField(key, "maxConcurrent", e.target.value === "" ? undefined : Number(e.target.value) || 1) }),
									jsx("input", { type: "number", min: 1, className: "rlr-input", style: { width: 60 }, title: "RPM", placeholder: "RPM", value: cfg.models?.[key]?.maxRpm ?? "", onChange: (e) => setModelField(key, "maxRpm", e.target.value === "" ? undefined : Number(e.target.value) || 1) }),
									cfg.strategy !== "sliding-window" && jsx("input", { type: "number", min: 1, className: "rlr-input", style: { width: 60 }, title: "突发", placeholder: "突发", value: cfg.models?.[key]?.burstSize ?? "", onChange: (e) => setModelField(key, "burstSize", e.target.value === "" ? undefined : Number(e.target.value) || 1) }),
									jsx("button", { className: "rlr-btnSec", onClick: () => { const v = cfg.models?.[key]?.enabled; setModelField(key, "enabled", v === false ? undefined : false); }, children: cfg.models?.[key]?.enabled === false ? "已禁用" : "禁用" }),
								] }),
							] }),
							jsx("button", { className: "rlr-danger", onClick: () => removeModel(key), title: "删除", children: "✕" }),
						] })),
					] }),
					/* ── 被限速时的行为 ── */
					jsxs("div", { className: "rlr-section", children: [
						jsx("div", { className: "rlr-sectHead", children: "被限速时的行为" }),
						jsxs("div", { className: "rlr-row", children: [
							jsx("label", { style: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }, children: [
								jsx("input", { type: "radio", name: "rl-on-throttle", checked: cfg.onThrottled !== "reject", onChange: () => setTop("onThrottled", "queue") }),
								"排队等待",
							] }),
							jsx("label", { style: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }, children: [
								jsx("input", { type: "radio", name: "rl-on-throttle", checked: cfg.onThrottled === "reject", onChange: () => setTop("onThrottled", "reject") }),
								"拒绝请求",
							] }),
						] }),
						cfg.onThrottled !== "reject" && jsxs("div", { className: "rlr-row", children: [
							jsx("span", { className: "rlr-label", children: "最大排队等待 (ms)" }),
							jsx("input", { type: "number", min: 1000, step: 1000, className: "rlr-input", value: cfg.maxQueueWaitMs ?? 60000, onChange: (e) => setTop("maxQueueWaitMs", Number(e.target.value) || 60000) }),
						] }),
					] }),
				] }),
			] });
		}

		/* ── Plugin registration ── */
		function apply(ctx) {
			const scope = ctx.settingsScope.bind({ namespace: name });
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					key: name,
					locale: name,
					inject: () => ({ settingsScope: scope }),
				}, RateLimiterCard);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});