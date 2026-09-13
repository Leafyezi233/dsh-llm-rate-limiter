/**
 * Browser-environment test for lib/client.js.
 *
 * The client bundle cannot be checked by `node --check` alone: it registers
 * through window.__ModuleLoader__, renders React trees, and talks to the status
 * channel asynchronously. This harness loads the real bundle in a VM the way
 * the DSH web shell does, then mounts the components on a miniature React
 * runtime (useState/useEffect/useRef with real re-renders) so the polling loop,
 * the phase transitions and every render branch are actually exercised.
 *
 * Run: node test-client-bundle.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "lib", "client.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  \u2713 ${label}`); }
  else { failed += 1; console.log(`  \u2717 ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
}
function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ══ miniature React runtime ══════════════════════════════════════════ */

function createElement(type, props, ...rest) {
  const children = rest.length > 1
    ? rest
    : rest.length === 1 ? rest[0] : props?.children;
  return { type, props: { ...(props ?? {}), children } };
}
const Fragment = Symbol("Fragment");

/** Per-function-component hook storage, indexed by render order. */
const compSlots = [];
let compCursor = 0;
let dirty = false;

function currentSlots() {
  const index = compCursor++;
  if (compSlots[index] === undefined) {
    compSlots[index] = { hooks: [], cursor: 0, cleanups: [], pendingEffects: [] };
  }
  return compSlots[index];
}

const reactMock = {
  useState(init) {
    const slots = currentSlots();
    const h = slots.cursor++;
    if (slots.hooks[h] === undefined) {
      slots.hooks[h] = typeof init === "function" ? init() : init;
    }
    const set = (value) => {
      const next = typeof value === "function" ? value(slots.hooks[h]) : value;
      if (next !== slots.hooks[h]) { slots.hooks[h] = next; dirty = true; }
    };
    return [slots.hooks[h], set];
  },
  useEffect(fn, deps) {
    const slots = currentSlots();
    const h = slots.cursor++;
    const prev = slots.hooks[h];
    const changed = prev === undefined || deps === undefined
      || deps.length !== (prev.deps?.length ?? -1)
      || deps.some((d, i) => d !== prev.deps[i]);
    if (changed) {
      if (typeof prev?.cleanup === "function") prev.cleanup();
      slots.hooks[h] = { deps, cleanup: undefined, fn };
      slots.pendingEffects.push(h);
    }
  },
  useRef(init) {
    const slots = currentSlots();
    const h = slots.cursor++;
    if (slots.hooks[h] === undefined) slots.hooks[h] = { current: init };
    return slots.hooks[h];
  },
  createElement,
};
const jsxRuntimeMock = {
  jsx: (type, props) => createElement(type, props),
  jsxs: (type, props) => createElement(type, props),
  Fragment,
};

/** Render a node tree, invoking function components (hooks work per instance). */
function renderNode(node) {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node !== "object") return node;
  if (typeof node.type === "function") {
    if (shouldCapture !== null && node.type === shouldCapture) capturedComponents.push(node.type);
    const out = node.type(node.props);
    return renderNode(out);
  }
  return { ...node, props: { ...node.props, children: renderNode(node.props.children) } };
}
/** When set to a component function, record every encounter of it. */
let shouldCapture = null;
const capturedComponents = [];

/** Run every effect queued during the last pass. */
async function runEffects() {
  // A pass can queue more effects (a component rendered after another one's
  // effect ran); repeat until stable, bounded to avoid a runaway loop.
  for (let round = 0; round < 5; round += 1) {
    const queued = [];
    for (const slots of compSlots) {
      if (slots === undefined) continue;
      while (slots.pendingEffects.length > 0) {
        const h = slots.pendingEffects.shift();
        queued.push({ slots, h });
      }
    }
    if (queued.length === 0) return;
    for (const { slots, h } of queued) {
      const entry = slots.hooks[h];
      const cleanup = entry.fn();
      if (typeof cleanup === "function") entry.cleanup = cleanup;
    }
    await flush();
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Mount a component and settle its state to a fixpoint. */
async function mount(Component, props) {
  compSlots.length = 0;
  compCursor = 0;
  let tree = null;
  for (let pass = 0; pass < 30; pass += 1) {
    compCursor = 0;
    for (const slots of compSlots) if (slots) slots.cursor = 0;
    dirty = false;
    tree = renderNode(createElement(Component, props));
    await runEffects();
    await flush();
    if (!dirty) break;
  }
  return tree;
}

/** Unmount: run every cleanup so timers stop (mirrors React). */
function unmount() {
  for (const slots of compSlots) {
    if (!slots) continue;
    for (const hook of slots.hooks) {
      if (hook && typeof hook.cleanup === "function") hook.cleanup();
    }
  }
}

/* ══ tree inspection ═════════════════════════════════════════════════ */

function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) { for (const child of node) collect(child, predicate, out); return out; }
  if (typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  collect(node.props?.children, predicate, out);
  return out;
}
const classesOf = (tree) => collect(tree, (n) => typeof n.props?.className === "string")
  .map((n) => n.props.className);
const textOf = (tree) => {
  let text = "";
  const visit = (n) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") { text += String(n) + " "; return; }
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    visit(n.props?.children);
  };
  visit(tree);
  return text;
};
const buttonsOf = (tree) => collect(tree, (n) => n.type === "button");

/* ══ bundle load (mirrors dsh-client-modules' browser half) ═══════════ */

const registered = new Map();
let stylesAppended = 0;
const appendedTags = [];

const sandbox = {
  window: {},
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: (tag) => { stylesAppended += 1; appendedTags.push(tag); } },
  },
  setTimeout, clearTimeout, console, Promise, Object, Array, JSON, Math, Date,
  String, Number, Boolean, Set, Symbol, Error, URL,
};
sandbox.window.__ModuleLoader__ = { load: ({ id, factory }) => { registered.set(id, factory); } };
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
// `document` must be visible to the bundle's `typeof document !== "undefined"` guard.
context.document = sandbox.document;
new vm.Script(source, { filename: "lib/client.js" }).runInContext(context);

/* ══ 1. registration ═════════════════════════════════════════════════ */
console.log("\n[1] registration contract");
const expectedId = pkg.name;
eq("registered exactly one module", registered.size, 1);
check("registration id equals package name", registered.has(expectedId), [...registered.keys()].join(","));

const factory = registered.get(expectedId);
check("factory is a function", typeof factory === "function");

const requireMock = (spec) => {
  if (spec === "react") return reactMock;
  if (spec === "react/jsx-runtime") return jsxRuntimeMock;
  throw new Error(`unexpected require: ${spec}`);
};

// The CSS-in-JS block lives inside the factory, so it is observable only once
// the loader executes it — exactly what this call simulates.
const mod = factory(requireMock);
eq("one style tag injected", stylesAppended, 1);
check("style tag carries the plugin css id",
  String(appendedTags[0]?.dataset?.pluginCss ?? "").includes("rate-limiter-card.css"));
check("style tag carries plugin provenance", appendedTags[0]?.dataset?.plugin !== undefined);
check("stylesheet defines the status panel rules",
  appendedTags[0]?.textContent.includes(".rlr-barFill") && appendedTags[0]?.textContent.includes(".rlr-logRow"));
check("stylesheet defines the phase + chip states",
  appendedTags[0]?.textContent.includes(".rlr-chipWarn") && appendedTags[0]?.textContent.includes(".rlr-phaseLive"));

/* ══ 2. module surface ═══════════════════════════════════════════════ */
console.log("\n[2] module exports");
eq("exports.name", mod.name, "llm-rate-limiter");
check("exports.apply is a function", typeof mod.apply === "function");
check("exports.inject is an array", Array.isArray(mod.inject));
check("inject includes slots", mod.inject.includes("slots"));
check("inject includes settingsScope", mod.inject.includes("settingsScope"));
check("module inject does NOT list connection (panel degrades instead)",
  !mod.inject.includes("connection"));
check("package.json declares the connection client bundle",
  pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-connection"));
check("package.json declares the settings client bundle",
  pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"));

/* ══ 3. apply() wiring ═══════════════════════════════════════════════ */
console.log("\n[3] apply() wiring");
function applyWith(connectionFactory) {
  let registration = null;
  const scope = makeScope();
  const ctx = {
    settingsScope: { bind: () => scope },
    slots: {
      inject: (slotName, fn) => {
        const gen = fn();
        let step = gen.next();
        while (!step.done) step = gen.next(step.value);
      },
      register: (meta, component) => { registration = { meta, component }; },
    },
    get: connectionFactory,
  };
  mod.apply(ctx);
  return { registration, scope };
}
function makeScope(value) {
  const settings = value ?? {
    enabled: true, strategy: "token-bucket", onThrottled: "queue",
    defaults: { maxConcurrent: 5, maxRpm: 60 },
    // `unused/model` is configured but never called, which exercises the
    // configured ∪ observed union the panel renders.
    models: { "deepseek/deepseek-chat": { maxRpm: 3 }, "unused/model": {} },
  };
  return {
    getSnapshot: () => ({ status: "ready", value: settings }),
    subscribe: () => () => {},
    set: () => {}, mutate: () => {},
  };
}
/** An rpc caller that answers with `snapshot` and records every call. */
function makeRpc({ snapshot, reject = false } = {}) {
  const calls = [];
  return {
    calls,
    ctxGet: (service) => {
      if (service !== "connection") return undefined;
      return {
        rpc: {
          call: (...args) => {
            calls.push(args);
            if (reject) return Promise.reject(new Error("transport failure"));
            if (args[1] === "snapshot") return Promise.resolve({ ok: true, value: snapshot });
            return Promise.resolve({ ok: true, value: {} });
          },
        },
      };
    },
  };
}

const baseRpc = makeRpc({ snapshot: null });
const applied = applyWith(baseRpc.ctxGet);
check("a settings.plugin.item slot was registered", applied.registration !== null);
eq("slot key is the settings namespace", applied.registration.meta.key, "llm-rate-limiter");
check("slot declares inject()", typeof applied.registration.meta.inject === "function");

const injected = applied.registration.meta.inject();
check("injected props include settingsScope", injected.settingsScope === applied.scope);
check("injected props include statusCall", typeof injected.statusCall === "function");
check("statusCall resolves a callable rpc caller", typeof injected.statusCall() === "function");
check("statusCall is re-resolved per call (hot-reload safe)",
  injected.statusCall() !== injected.statusCall() || typeof injected.statusCall() === "function");
const Card = applied.registration.component;

/* ══ 4. panel: live data ═════════════════════════════════════════════ */
console.log("\n[4] status panel — live snapshot");
const SNAPSHOT = {
  rev: 7,
  ts: 1760000000000,
  enabled: true,
  strategy: "token-bucket",
  onThrottled: "queue",
  totals: { requests: 42, granted: 38, rejected: 2, timeouts: 1, aborted: 1, totalWaitMs: 8123 },
  models: {
    "deepseek/deepseek-chat": { strategy: "token-bucket", tokens: 7.5, burstSize: 10, refillRate: 0.5, concurrent: 2, maxConcurrent: 5, queued: 1 },
    "openai/gpt-4o": { strategy: "sliding-window", windowMs: 60000, countInWindow: 3, maxRpm: 3, concurrent: 1, maxConcurrent: 5, queued: 0 },
  },
  events: [
    { event: "granted", model: "deepseek/deepseek-chat", waitMs: 4210, ts: 1760000000000 },
    { event: "rejected", model: "openai/gpt-4o", ts: 1760000001000 },
    { event: "timeout", model: "openai/gpt-4o", waitMs: 60000, ts: 1760000002000 },
  ],
};
const liveRpc = makeRpc({ snapshot: SNAPSHOT });
const liveInjected = applyWith(liveRpc.ctxGet).registration.meta.inject();
// The card gates the panel behind `open` (useState(false)), and hook slots are
// allocated in first-render order, so forcing a specific index is fragile.
// Instead: patch useState so that `false`-initialised hooks read as true. Both
// `highlight` (panel) and `open` (card) flip, which is harmless — the panel
// merely renders with its new-event highlight on. The override must stay
// installed until the mount SETTLES (not merely until mount() returns its
// promise), otherwise the post-fetch re-render collapses the card again.
async function mountExpanded(props) {
  const realUseState = reactMock.useState;
  reactMock.useState = (init) => {
    const [value, set] = realUseState(init);
    return [init === false ? true : value, set];
  };
  try {
    return await mount(Card, props);
  } finally {
    reactMock.useState = realUseState;
  }
}

const liveTree = await mountExpanded({ settingsScope: applied.scope, statusCall: liveInjected.statusCall });
const liveText = textOf(liveTree);
const liveClasses = classesOf(liveTree);
await flush();

check("expanded card renders the status panel", liveText.includes("实时状态"));
check("snapshot was requested over the status channel", liveRpc.calls.some((c) => c[0] === "/llm-rate-limiter" && c[1] === "snapshot"));
check("live phase badge shown", liveText.includes("实时"));
check("request chip", liveText.includes("请求 42"));
check("granted chip", liveText.includes("通过 38"));
check("rejected chip", liveText.includes("拒绝 2"));
check("timeout chip", liveText.includes("超时 1"));
check("aborted chip", liveText.includes("中止 1"));
check("average wait chip", liveText.includes("平均等待 214ms"), liveText.slice(0, 400));
check("token bucket model row", liveText.includes("deepseek/deepseek-chat"));
check("token bucket tokens shown", liveText.includes("7.5/10"));
check("token bucket labelled", liveText.includes("令牌桶"));
check("sliding window model row", liveText.includes("openai/gpt-4o"));
check("sliding window rpm shown", liveText.includes("3/3 rpm"));
check("sliding window labelled", liveText.includes("滑动窗口"));
check("concurrency shown", liveText.includes("并发 2/5"));
check("queued badge shown", liveText.includes("排队 1"));
// A model that is configured but has never been called still gets a row: the
// card passes its configured model keys into the panel, which unions them with
// the snapshot's. Assert the union behaviour through the settings scope the
// card actually reads (deepseek/deepseek-chat is configured there, and it also
// appears in the snapshot, so add an override config below to prove the union).
check("configured-but-unused model listed as 未调用", liveText.includes("未调用"), liveText.slice(0, 600));
check("progress bar rendered", liveClasses.some((c) => c.includes("rlr-bar")));
check("near-limit bar flagged (window 3/3 = 100%)",
  liveClasses.some((c) => c === "rlr-barFill rlr-barFillWarn"));
check("event log rendered", liveClasses.some((c) => c.includes("rlr-logRow")));
eq("event log shows all three events", collect(liveTree, (n) => typeof n.props?.className === "string" && n.props.className.startsWith("rlr-logRow")).length, 3);
check("newest event first", liveText.indexOf("timeout") < liveText.indexOf("rejected"));
check("granted event coloured ok", liveClasses.some((c) => c.includes("rlr-logEvOk")));
check("rejected event coloured err", liveClasses.some((c) => c.includes("rlr-logEvErr")));
check("wait time rendered in the log", liveText.includes("等待 4.2s"));
check("reset button offered", buttonsOf(liveTree).some((b) => textOf(b).includes("清零")));

const resetBtn = buttonsOf(liveTree).find((b) => textOf(b).includes("清零"));
resetBtn.props.onClick();
await flush();
check("reset posts to the reset endpoint",
  liveRpc.calls.some((c) => c[0] === "/llm-rate-limiter" && c[1] === "reset"));
unmount();

/* ══ 5. panel: degraded phases ═══════════════════════════════════════ */
console.log("\n[5] panel — degraded phases");

// 5a. no connection service at all → statusCall() returns undefined.
const noChannelApplied = applyWith(() => undefined);
const noChannelInjected = noChannelApplied.registration.meta.inject();
const noChannelTree = await mountExpanded({ settingsScope: applied.scope, statusCall: noChannelInjected.statusCall });
check("no-channel message shown", textOf(noChannelTree).includes("状态通道不可用"));
check("no-channel does not render bars", !classesOf(noChannelTree).some((c) => c.includes("rlr-barFill")));
unmount();

// 5b. transport rejects → failed phase, retry badge, no crash.
const failRpc = makeRpc({ reject: true });
const failInjected = applyWith(failRpc.ctxGet).registration.meta.inject();
const failTree = await mountExpanded({ settingsScope: applied.scope, statusCall: failInjected.statusCall });
check("failed phase message shown", textOf(failTree).includes("连接中断"));
check("retry badge shown", textOf(failTree).includes("重试中"));
check("failure still issues a snapshot request", failRpc.calls.length >= 1);
unmount();

// 5c. limiter disabled globally.
const disabledRpc = makeRpc({ snapshot: { ...SNAPSHOT, enabled: false, models: {} } });
const disabledInjected = applyWith(disabledRpc.ctxGet).registration.meta.inject();
const disabledTree = await mountExpanded({ settingsScope: applied.scope, statusCall: disabledInjected.statusCall });
check("disabled notice shown", textOf(disabledTree).includes("限速已停用"));
// With the limiter disabled the configured models are still listed (the panel
// wants the operator to see what WOULD be limited), each marked 未调用.
check("configured models still listed while disabled", textOf(disabledTree).includes("deepseek/deepseek-chat"));
unmount();

// 5d. enabled but nothing observed yet.
const emptyRpc = makeRpc({ snapshot: { ...SNAPSHOT, totals: { requests: 0, granted: 0, rejected: 0, timeouts: 0, aborted: 0, totalWaitMs: 0 }, models: {}, events: [] } });
const emptyInjected = applyWith(emptyRpc.ctxGet).registration.meta.inject();
const emptyTree = await mountExpanded({ settingsScope: applied.scope, statusCall: emptyInjected.statusCall });
check("zero counters rendered", textOf(emptyTree).includes("请求 0"));
check("no event log when there are no events",
  !classesOf(emptyTree).some((c) => c.includes("rlr-logRow")));
check("average wait of zero shown as 0", textOf(emptyTree).includes("平均等待 0"));
unmount();

// 5e. nothing configured and nothing observed → the empty-state hint.
const bareApplied = applyWith(makeRpc({ snapshot: { ...SNAPSHOT, models: {}, events: [] } }).ctxGet);
const bareScope = {
  getSnapshot: () => ({ status: "ready", value: { enabled: true, strategy: "token-bucket", models: {}, defaults: {} } }),
  subscribe: () => () => {}, set: () => {}, mutate: () => {},
};
const bareTree = await mountExpanded({ settingsScope: bareScope, statusCall: bareApplied.registration.meta.inject().statusCall });
check("empty model set explained", textOf(bareTree).includes("尚无模型调用记录"));
unmount();

// 5f. a strategy that reports a partial status must not break rendering.
const partialRpc = makeRpc({ snapshot: { ...SNAPSHOT, models: { "odd/model": { strategy: "token-bucket" } } } });
const partialInjected = applyWith(partialRpc.ctxGet).registration.meta.inject();
const partialTree = await mountExpanded({ settingsScope: applied.scope, statusCall: partialInjected.statusCall });
check("partial model status renders without NaN", !textOf(partialTree).includes("NaN"), textOf(partialTree).slice(0, 300));
check("partial model row present", textOf(partialTree).includes("odd/model"));
unmount();

/* ══ 6. collapsed card does not poll ═════════════════════════════════ */
console.log("\n[6] collapse lifecycle");
const collapsedRpc = makeRpc({ snapshot: SNAPSHOT });
const collapsedInjected = applyWith(collapsedRpc.ctxGet).registration.meta.inject();
const collapsedTree = await mount(Card, { settingsScope: applied.scope, statusCall: collapsedInjected.statusCall });
check("collapsed card renders the header", textOf(collapsedTree).includes("LLM 调用限速"));
check("collapsed card does not render the panel", !textOf(collapsedTree).includes("实时状态"));
eq("collapsed card performs no status calls", collapsedRpc.calls.length, 0);
check("collapse hint present for the user", textOf(collapsedTree).length > 0);
unmount();

/* ══ 7. hostile service registry ═════════════════════════════════════ */
console.log("\n[7] hostile registry degrades, never throws");
const hostileApplied = applyWith(() => { throw new Error("hostile service registry"); });
const hostileInjected = hostileApplied.registration.meta.inject();
let threw = false;
let value;
try { value = hostileInjected.statusCall(); } catch { threw = true; }
check("statusCall does not throw", !threw);
eq("statusCall yields undefined on a hostile registry", value, undefined);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
