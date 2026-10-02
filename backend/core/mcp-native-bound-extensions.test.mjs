import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { DefaultResourceLoader, SettingsManager, initTheme } from "@earendil-works/pi-coding-agent";
import { createBackendMcpConfigOwner } from "./mcp-native-config-owner.mjs";
import { prepareBackendMcpExtensionsFromBinding as compose } from "./mcp-native-extensions.mjs";
const safe = (e) => e instanceof Error && e.message === "MCP extension binding unavailable" && e.cause === undefined;
function failure(result, code) { assert.equal(result.ok, false); assert.equal(result.factories, null); if (code) assert.equal(result.issues[0].code, code); assert.equal(JSON.stringify(result).includes("private"), false); }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-bound-extensions-")); fs.chmodSync(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "mcp.json"), bundledConfigPath = join(root, "bundle.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { fixture: { command: "never-run-private-command", enabled: false } } }), { mode: 0o600 });
  await writeFile(bundledConfigPath, "{}", { mode: 0o600 });
  const owner = createBackendMcpConfigOwner({ agentDir: root, bundledConfigPath, assertProcessOwner() {}, assertPrivateStorage() {} });
  t.after(() => owner.dispose());
  const binding = await owner.prepare(), calls = { credentials: 0, browser: 0, transport: 0 };
  const never = (name) => () => { calls[name]++; throw Error("private-service-error"); };
  const mcp = { credentials: { forServer: never("credentials"), tokens: never("credentials"), remove: never("credentials") }, openUrl: never("browser"), createTransport: never("transport"), startupWaitMs: 0 };
  return { root, configPath, bundledConfigPath, owner, binding, calls, mcp };
}
function stub() {
  const tools = [], commands = new Map(), events = new Map();
  const pi = { registerTool: (tool) => tools.push(tool), registerCommand: (name, command) => commands.set(name, command),
    getSettings: () => ({}), on: (name, handler) => events.set(name, handler) };
  return { pi, tools, commands, events };
}

test("real owner composition/register uses guarded handles without loader rereads, connections, writes or SDK defaults", async (t) => {
  const f = await fixture(t), original = await readFile(f.configPath), files = await readdir(f.root);
  assert.equal(f.binding.logPath, join(f.root, "mcp.log"));
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  const reread = mock.method(fs.promises, "readFile", () => { throw Error("private unexpected snapshot reread"); }); syncBuiltinESMExports();
  const result = compose({ binding: f.binding, mcp: f.mcp }); assert.equal(result.ok, true); assert.equal(result instanceof Promise, false);
  assert.equal(result.factories.length, 3); assert.equal(result.sourceSha256, f.binding.prepared.sourceSha256); assert.equal(result.bundledSha256, f.binding.prepared.bundledSha256); assert.equal(result.serverCount, 1);
  const host = stub(); for (const factory of result.factories) await factory(host.pi);
  assert.deepEqual(host.tools.map((tool) => tool.name).sort(), ["codemode", "tool_search"]); assert.equal(host.commands.has("mcp"), true);
  assert.equal(host.tools.every((tool) => tool.defaultActive === false), true); assert.equal(host.tools[0].description.includes("`models`"), false);
  assert.equal(reread.mock.callCount(), 0); reread.mock.restore(); syncBuiltinESMExports();
  assert.deepEqual(await readFile(f.configPath), original); assert.deepEqual(await readdir(f.root), files); assert.deepEqual(f.calls, { credentials: 0, browser: 0, transport: 0 });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("real SDK ResourceLoader accepts guarded factory signatures but stale factories cannot register after save/reprepare", async (t) => {
  const f = await fixture(t), first = compose({ binding: f.binding, mcp: f.mcp });
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: first.factories });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  f.binding.updateConfig(f.binding.loadConfig().servers[0], { enabled: false }); // Entered no-op still closes all old binding consumers.
  failure(compose({ binding: f.binding, mcp: f.mcp }), "native-extension-binding-failed");
  const host = stub(); for (const factory of first.factories) await assert.rejects(factory(host.pi), safe);
  assert.deepEqual(host.tools, []); assert.equal(host.commands.size, 0); assert.equal(host.events.size, 0);
  const next = await f.owner.prepare(), fresh = compose({ binding: next, mcp: f.mcp }); assert.equal(fresh.ok, true);
  const newHost = stub(); for (const factory of fresh.factories) await factory(newHost.pi); assert.equal(newHost.commands.has("mcp"), true);
  await assert.rejects(first.factories[0](stub().pi), safe); next.assertOwner(); assert.deepEqual(f.calls, { credentials: 0, browser: 0, transport: 0 });
});

test("SDK session_start uses the same guarded loader; no implicit fresh snapshot after observed source changes", async (t) => {
  const f = await fixture(t), result = compose({ binding: f.binding, mcp: f.mcp }), host = stub(), bytes = await readFile(f.configPath);
  await result.factories[2](host.pi);
  const ctx = { cwd: f.root, modelRegistry: {}, ui: { notify() { throw Error("Unexpected notification"); } } };
  host.pi.getMcpServers = () => []; host.pi.getAllTools = () => []; host.pi.getActiveTools = () => []; host.pi.setActiveTools = () => {};
  host.events.get("session_start")({}, ctx); // Disabled server: no runtime/transport/credential/log IO.
  await writeFile(f.configPath, Buffer.concat([bytes, Buffer.from("\n")]));
  assert.throws(() => host.events.get("session_start")({}, ctx), safe);
  await writeFile(f.configPath, bytes);
  assert.throws(() => host.events.get("session_start")({}, ctx), safe);
  assert.deepEqual(f.calls, { credentials: 0, browser: 0, transport: 0 }); assert.deepEqual((await readdir(f.root)).sort(), ["bundle.json", "mcp.json"]);
});

test("real SDK manager saves through the binding synchronously; invalid selectors remain retryable and async writers cannot acknowledge success", async (t) => {
  const f = await fixture(t); initTheme("dark", false); // Bundled theme only; no watcher or user-file mutation.
  async function manage(binding, choices) {
    const result = compose({ binding, mcp: f.mcp }), host = stub(), messages = [], menus = [];
    await result.factories[2](host.pi);
    host.pi.getMcpServers = () => []; host.pi.getAllTools = () => []; host.pi.getActiveTools = () => []; host.pi.setActiveTools = () => {};
    const ctx = { mode: "tui", cwd: f.root, modelRegistry: {}, ui: { notify: (message) => messages.push(message), custom: (build) => new Promise((resolve) => {
      const view = build({ requestRender() {} }, { fg: (_key, text) => text, bold: (text) => text }, { matches: () => false }, resolve);
      view.menu = async (menu) => { menus.push(menu()); return choices.shift(); };
      view.handleInput("\r");
    }) } };
    host.events.get("session_start")({}, ctx); await host.commands.get("mcp").handler("", ctx);
    assert.deepEqual(messages, []); return { host, menus };
  }
  const { menus } = await manage(f.binding, ["exposure", "private-invalid-exposure", "exposure", "direct", undefined, undefined]);
  assert.equal(menus.some((menu) => menu.error?.endsWith("MCP extension binding unavailable")), true);
  assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).mcpServers.fixture.exposure, "direct");
  assert.throws(f.binding.loadConfig, /MCP configuration owner unavailable/);
  const next = await f.owner.prepare(); let calls = 0;
  const bad = await manage({ ...next, updateConfig: () => { calls++; return Promise.reject(Error("private async write")); } }, ["exposure", "hidden", undefined, undefined]);
  assert.equal(calls, 1); assert.equal(bad.menus.some((menu) => menu.error?.endsWith("MCP extension binding unavailable")), true);
  assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).mcpServers.fixture.exposure, "direct");
  assert.throws(() => bad.host.events.get("session_start")({}, {}), safe); next.assertOwner(); await new Promise((r) => setImmediate(r));
});

test("strict bound options/services/metadata cannot select sources, log paths, updater or loader fallbacks", async (t) => {
  const f = await fixture(t), input = { binding: f.binding, mcp: f.mcp };
  for (const options of [null, [], {}, Object.create(input), { ...input, agentDir: f.root }, { ...input, bundledConfigPath: f.bundledConfigPath }, { ...input, urlVariables: {} }, { ...input, [Symbol("private")]: true }]) failure(compose(options), "invalid-native-extension-options");
  for (const mcp of [null, {}, { ...f.mcp, updateConfig() {} }, { ...f.mcp, loadConfig() {} }, { ...f.mcp, logPath: f.binding.logPath }, { ...f.mcp, credentials: undefined }, { ...f.mcp, openUrl: undefined }, { ...f.mcp, createTransport: null }]) failure(compose({ ...input, mcp }));
  for (const binding of [undefined, {}, Object.create(f.binding), { ...f.binding, logPath: "relative/mcp.log" }, { ...f.binding, loadConfig: undefined }, { ...f.binding, updateConfig: async () => {} }, { ...f.binding, assertOwner: async () => {} }, { ...f.binding, prepared: { ...f.binding.prepared, loadConfig: () => ({ servers: [], errors: [] }) } }, { ...f.binding, prepared: { ...f.binding.prepared, sourceSha256: "private-invalid" } }]) failure(compose({ ...input, binding }));
  f.binding.assertOwner(); assert.deepEqual(f.calls, { credentials: 0, browser: 0, transport: 0 });
});

test("captures binding/metadata/services getters once and refuses binding lost during service capture", async (t) => {
  const f = await fixture(t), counts = {}, capture = (source, prefix) => Object.fromEntries(Object.keys(source).map((key) => [key, { enumerable: true, get() { const name = `${prefix}.${key}`; counts[name] = (counts[name] ?? 0) + 1; if (counts[name] > 1) throw Error("private repeated getter"); return source[key]; } }]));
  const prepared = Object.defineProperties({}, capture(f.binding.prepared, "prepared"));
  const binding = Object.defineProperties({}, capture({ ...f.binding, prepared }, "binding")), mcp = Object.defineProperties({}, capture(f.mcp, "mcp"));
  const result = compose({ binding, mcp }); assert.equal(result.ok, true); assert.equal(Object.values(counts).every((n) => n === 1), true);
  const host = stub(); for (const factory of result.factories) await factory(host.pi); assert.equal(Object.values(counts).every((n) => n === 1), true);
  const unsafe = { ...f.mcp, get openUrl() { f.owner.dispose(); return f.mcp.openUrl; } };
  failure(compose({ binding: f.binding, mcp: unsafe }), "native-extension-binding-failed");
});

test("async authority acknowledgments and swallowed reentrancy fence the entire factory family", async (t) => {
  const f = await fixture(t);
  failure(compose({ binding: { ...f.binding, assertOwner: () => Promise.reject(Error("private async authority")) }, mcp: f.mcp }), "native-extension-binding-failed");
  let result, reenter = false, calls = 0;
  result = compose({ binding: { ...f.binding, assertOwner() { calls++; if (reenter) result.factories[0](stub().pi).catch(() => undefined); } }, mcp: f.mcp });
  assert.equal(result.ok, true); const initial = calls; reenter = true;
  const host = stub(); await assert.rejects(result.factories[0](host.pi), safe); assert.equal(calls, initial + 1); assert.deepEqual(host.tools, []);
  reenter = false; await assert.rejects(result.factories[2](host.pi), safe); assert.equal(host.events.size, 0); await new Promise((r) => setImmediate(r));
});

test("a later family registration error blocks already registered session_start; async load results cannot masquerade as snapshots", async (t) => {
  const f = await fixture(t), result = compose({ binding: f.binding, mcp: f.mcp }), host = stub();
  await result.factories[2](host.pi);
  host.pi.registerTool = () => { throw Error("private registration error"); };
  await assert.rejects(result.factories[0](host.pi), safe);
  assert.throws(() => host.events.get("session_start")({}, {}), safe); f.binding.assertOwner();
  const asyncLoad = () => Promise.reject(Error("private async snapshot"));
  const bad = compose({ binding: { ...f.binding, loadConfig: asyncLoad, prepared: { ...f.binding.prepared, loadConfig: asyncLoad } }, mcp: f.mcp });
  const nextHost = stub(); await bad.factories[2](nextHost.pi);
  assert.throws(() => nextHost.events.get("session_start")({}, {}), safe);
  await assert.rejects(bad.factories[0](nextHost.pi), safe); await new Promise((r) => setImmediate(r));
});

test("supersession between synchronous registration and async completion rejects publication", async (t) => {
  const f = await fixture(t), result = compose({ binding: f.binding, mcp: f.mcp }), host = stub();
  const registration = result.factories[0](host.pi); const preparing = f.owner.prepare();
  await assert.rejects(registration, safe); const fresh = await preparing; fresh.assertOwner();
  assert.equal(host.tools.length, 1); await assert.rejects(result.factories[2](host.pi), safe); assert.equal(host.events.size, 0);
});

test("authority lost inside factory registration prevents successful completion, without claiming rollback", async (t) => {
  const f = await fixture(t), result = compose({ binding: f.binding, mcp: f.mcp }), host = stub();
  host.pi.registerTool = (tool) => { host.tools.push(tool); f.owner.dispose(); };
  await assert.rejects(result.factories[0](host.pi), safe);
  assert.equal(host.tools.length, 1); // Registration is not transactional; caller must refuse publication.
  await assert.rejects(result.factories[2](host.pi), safe); assert.equal(host.events.size, 0);
});
