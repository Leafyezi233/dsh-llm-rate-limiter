/**
 * Real-runtime check: does the INSTALLED plugin (through the web profile's
 * junction) load under the actual DSH module resolution rules, and does its
 * patch/channel surface match what the framework expects?
 *
 * This is the last gate before publishing: it resolves the plugin exactly as
 * DSH does (package name → node_modules → package.json metadata → patch name →
 * client bundle id) using the live install, not the source tree.
 *
 * Run: node tools/verify-install.mjs   (from the plugin directory)
 */
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const PROFILE = "C:\\Users\\91298\\.dsh\\profiles\\web";
const SCOPED = "@leaf233/dsh-llm-rate-limiter";
const WORKSPACE = "D:\\dsh工作区1\\dsh-llm-rate-limiter";

let passed = 0;
let failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed += 1; console.log(`  \u2713 ${label}`); }
  else { failed += 1; console.log(`  \u2717 ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
};

console.log("\n[profile] install layout");
const profilePkg = JSON.parse(readFileSync(join(PROFILE, "package.json"), "utf8"));
check("bundles lists the scoped name", profilePkg.dsh.profile.bundles.includes(SCOPED));
check("dependencies has the scoped key", SCOPED in profilePkg.dependencies, profilePkg.dependencies[SCOPED]);
const nmPath = join(PROFILE, "node_modules", "@leaf233", "dsh-llm-rate-limiter");
check("node_modules entry exists", existsSync(nmPath));
if (existsSync(nmPath)) {
  check("entry resolves to this workspace", realpathSync(nmPath).toLowerCase() === WORKSPACE.toLowerCase(), realpathSync(nmPath));
}

console.log("\n[resolution] the specifier DSH will import");
const require = createRequire(join(PROFILE, "package.json"));
let hostEntry;
try { hostEntry = require.resolve(SCOPED); check("host entry resolves", true, hostEntry); }
catch (err) { check("host entry resolves", false, `${err.code}: ${err.message.split("\n")[0]}`); }
let clientEntry;
try { clientEntry = require.resolve(`${SCOPED}/client`); check("client bundle resolves", true, clientEntry); }
catch (err) { check("client bundle resolves", false, `${err.code}: ${err.message.split("\n")[0]}`); }

console.log("\n[metadata] what the framework reads");
const pkg = JSON.parse(readFileSync(join(WORKSPACE, "package.json"), "utf8"));
check("package name is scoped", pkg.name === SCOPED, pkg.name);
check("version is 0.2.1", pkg.version === "0.2.1", pkg.version);
check("dsh.client.platform = web", pkg.dsh?.client?.platform === "web");
check("client bundle dependency declared",
  pkg.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-connection"),
  JSON.stringify(pkg.dsh?.client?.inject));
check("settings bundle dependency declared",
  pkg.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-ui-settings"));
check("compatibility release declared",
  pkg.dsh?.compatibility?.dshReleases !== undefined,
  JSON.stringify(pkg.dsh?.compatibility));
check("0.1.5-rc.3 declared compatible",
  pkg.dsh?.compatibility?.dshReleases?.["0.1.5-rc.3"] === "compatible",
  JSON.stringify(pkg.dsh?.compatibility?.dshReleases));
check("exports[./client] declared", typeof pkg.exports?.["./client"] === "string");
check("patch declared", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");

const patch = readFileSync(join(WORKSPACE, "cordis.patch.yml"), "utf8");
const patchName = (patch.split(/\r?\n/).find((l) => /^\s*name:/.test(l)) ?? "")
  .replace(/^\s*name:\s*/, "").replace(/^['"]|['"]$/g, "").trim();
check("patch name equals package name", patchName === SCOPED, patchName);
check("patch keeps the stable plugin id", /id:\s*llm-rate-limiter/.test(patch));

const clientSource = readFileSync(join(WORKSPACE, "lib", "client.js"), "utf8");
const loadId = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/)?.[1] ?? "";
check("client bundle id equals package name", loadId === SCOPED, loadId);

console.log("\n[import] the plugin actually evaluates in this Node");
try {
  const mod = await import(new URL(`file:///${hostEntry.replace(/\\/g, "/")}`).href);
  check("host module imports", typeof mod.apply === "function");
  check("host plugin name unchanged", mod.name === "llm-rate-limiter", String(mod.name));
  check("settings namespace unchanged", mod.SETTINGS_NS === "llm-rate-limiter");
  const statusRpc = await import(new URL(`file:///${join(WORKSPACE, "lib", "status-rpc.js").replace(/\\/g, "/")}`).href);
  check("status channel constant exported", statusRpc.CHANNEL === "/llm-rate-limiter", statusRpc.CHANNEL);
  check("channel name passes the framework pattern", /^\/[A-Za-z0-9._~-]+$/.test(statusRpc.CHANNEL));
  // v0.2.1 fallback carrier surface (the DSH 0.1.5-rc.3 regression fix).
  check("createChannelRoute exported", typeof statusRpc.createChannelRoute === "function");
  check("endpointFromPath exported", typeof statusRpc.endpointFromPath === "function");
  const fallbackRoute = statusRpc.createChannelRoute({
    channel: statusRpc.CHANNEL, handler: async () => ({ ok: true, value: {} }), reject: () => undefined,
  });
  check("fallback route is a prefix route on the channel",
    fallbackRoute.kind === "prefix" && fallbackRoute.path === statusRpc.CHANNEL,
    `${fallbackRoute.kind} ${fallbackRoute.path}`);
} catch (err) {
  check("host module imports", false, err.message.split("\n")[0]);
}

console.log("\n[shipped files] what npm will publish");
for (const f of ["lib/index.js", "lib/client.js", "lib/status-rpc.js", "cordis.patch.yml"]) {
  check(`shipped: ${f}`, existsSync(join(WORKSPACE, f)));
}
check("status-rpc is covered by the files field",
  (pkg.files ?? []).some((pattern) => pattern === "lib/" || pattern === "lib/status-rpc.js" || pattern === "lib"),
  JSON.stringify(pkg.files));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
