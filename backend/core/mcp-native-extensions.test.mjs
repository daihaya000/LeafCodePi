import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { prepareBackendMcpExtensions } from "./mcp-native-extensions.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-mcp-extensions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "mcp.json");
  const bundledConfigPath = join(root, "bundled.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: {
    fixture: { command: process.execPath, args: ["-e", "throw Error('private-command')"], env: { SECRET: "!private-env-command" } },
    http: { url: "https://example.invalid/mcp", headers: { "X-Key": "!private-header-command" }, oauth: { clientSecret: "!private-oauth-command" } },
  } }));
  await writeFile(bundledConfigPath, JSON.stringify({ mcpServers: { bundled: { command: "fixture", enabled: true } } }));
  const calls = { transport: 0, credentials: 0, browser: 0, writer: 0 };
  const unavailable = (name) => () => { calls[name]++; throw new Error("private-service-error"); };
  const mcp = { credentials: { forServer: unavailable("credentials"), tokens: unavailable("credentials"), remove: unavailable("credentials") },
    openUrl: unavailable("browser"), updateConfig: unavailable("writer"), createTransport: unavailable("transport"), startupWaitMs: 0 };
  return { root, configPath, calls, options: { agentDir: root, bundledConfigPath, mcp } };
}
const safeFailure = (result, code) => {
  assert.equal(result.ok, false);
  assert.equal(result.factories, null);
  if (code) assert.equal(result.issues[0].code, code);
  assert.equal(JSON.stringify(result).includes("private"), false);
};

async function register(t, factories) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-factory-register-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
    settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], codemode: { mode: "only" } }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: factories,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  return { root, extensions: loader.getExtensions().extensions };
}

test("composes exactly three real SDK extensions without connecting, credentials, writes or browser activity", async (t) => {
  const { root, configPath, calls, options } = await fixture(t);
  const bytes = await readFile(configPath);
  const files = await readdir(root);
  const result = await prepareBackendMcpExtensions(options);
  assert.equal(result.ok, true);
  assert.equal(result.factories.length, 3);
  assert.equal(result.serverCount, 3);
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(result.bundledSha256, /^[a-f0-9]{64}$/);
  const registered = await register(t, result.factories);
  assert.equal(registered.extensions.filter((extension) => extension.commands.has("mcp")).length, 1);
  assert.equal(registered.extensions.filter((extension) => extension.tools.has("codemode")).length, 1);
  assert.equal(registered.extensions.filter((extension) => extension.tools.has("tool_search")).length, 1);
  const tools = registered.extensions.flatMap((extension) => [...extension.tools.values()].map((tool) => tool.definition));
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["codemode", "tool_search"]);
  assert.equal(tools.every((tool) => tool.defaultActive === false), true);
  assert.deepEqual(calls, { transport: 0, credentials: 0, browser: 0, writer: 0 });
  assert.deepEqual(await readFile(configPath), bytes);
  assert.deepEqual(await readdir(root), files);
  assert.deepEqual(await readdir(registered.root), []);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("codemode leaves direct tools declared and does not expose the model API", async (t) => {
  const { options } = await fixture(t);
  const result = await prepareBackendMcpExtensions(options);
  assert.equal(result.ok, true);
  // prepareLoadout needs bound pi.getSettings; a minimal host stub avoids session_start and connections.
  let definition;
  await result.factories[0]({ registerTool: (tool) => { definition = tool; },
    getSettings: () => ({ codemode: { mode: "only", inlineBudget: 2000 } }) });
  assert.equal(definition.description.includes("`models`"), false);
  const read = { name: "read", label: "Read", description: "Read a file", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) };
  const loadout = definition.prepareLoadout({ declared: [read], callable: [read], registered: [read],
    getExposure: () => "direct", getNamespace: () => undefined });
  assert.deepEqual(loadout.hiddenDeclarations ?? [], []);
  assert.equal(loadout.descriptions.codemode.includes("`models`"), false);
});

test("requires explicit complete owner services and refuses SDK overrides before file preparation", async (t) => {
  const { options } = await fixture(t);
  for (const mcp of [undefined, null, [],
    { ...options.mcp, loadConfig: () => ({ servers: [], errors: [] }) }, { ...options.mcp, logPath: "private-path" }]) {
    safeFailure(await prepareBackendMcpExtensions({ ...options, mcp }), "mcp-owner-services-required");
  }
  for (const mcp of [{}, { credentials: options.mcp.credentials }, { ...options.mcp, credentials: null }, { ...options.mcp, credentials: {} },
    { ...options.mcp, openUrl: false }, { ...options.mcp, updateConfig: undefined }, { ...options.mcp, createTransport: null },
    { ...options.mcp, startupWaitMs: -1 }, { ...options.mcp, startupWaitMs: 60_001 }, { ...options.mcp, startupWaitMs: 0.5 },
    Object.assign(Object.create(null), { credentials: options.mcp.credentials, openUrl: undefined, updateConfig: options.mcp.updateConfig })]) {
    safeFailure(await prepareBackendMcpExtensions({ ...options, mcp }), "invalid-mcp-owner-services");
  }
  for (const input of [null, [], { ...options, codemode: { models: true } }, { ...options, defaultTools: ["codemode"] }, Object.create(options)]) {
    safeFailure(await prepareBackendMcpExtensions(input), "invalid-native-extension-options");
  }
});

test("rejects malformed/unsupported source config without partial factories or owner-service calls", async (t) => {
  const { options, configPath, calls } = await fixture(t);
  for (const text of ["private-invalid-json", JSON.stringify({ mcpServers: { fixture: { url: "https://example.invalid", bearerTokenStore: true } } }),
    JSON.stringify({ mcpServers: { fixture: { command: "fixture", timeout: -1 } } })]) {
    await writeFile(configPath, text);
    safeFailure(await prepareBackendMcpExtensions(options));
    assert.equal((await readFile(configPath, "utf8")), text);
  }
  assert.deepEqual(calls, { transport: 0, credentials: 0, browser: 0, writer: 0 });
});

test("reprepares snapshots on each composition and ignores project configuration", async (t) => {
  const { options, root, configPath, calls } = await fixture(t);
  await mkdir(join(root, "project", ".pi"), { recursive: true });
  await writeFile(join(root, "project", ".pi", "mcp.json"), "private-invalid-project-json");
  const first = await prepareBackendMcpExtensions(options);
  assert.equal(first.ok, true);
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }));
  const second = await prepareBackendMcpExtensions(options);
  assert.equal(second.ok, true);
  assert.notEqual(first.sourceSha256, second.sourceSha256);
  assert.equal(second.serverCount, 1); // Only the disabled imported default remains.
  assert.notEqual(first.factories[0], second.factories[0]);
  assert.deepEqual(calls, { transport: 0, credentials: 0, browser: 0, writer: 0 });
});

test("captures owner paths/service getters once before validating and composing", async (t) => {
  const { options, calls } = await fixture(t);
  const reads = {};
  const mcp = {};
  for (const [key, value] of Object.entries(options.mcp)) {
    Object.defineProperty(mcp, key, { enumerable: true, get: () => {
      reads[key] = (reads[key] ?? 0) + 1;
      return reads[key] === 1 ? value : undefined;
    } });
  }
  const input = { bundledConfigPath: options.bundledConfigPath, mcp };
  Object.defineProperty(input, "agentDir", { enumerable: true, get: () => {
    reads.agentDir = (reads.agentDir ?? 0) + 1;
    return reads.agentDir === 1 ? options.agentDir : "private-other-path";
  } });
  const result = await prepareBackendMcpExtensions(input);
  assert.equal(result.ok, true);
  assert.deepEqual(reads, { credentials: 1, openUrl: 1, updateConfig: 1, createTransport: 1, startupWaitMs: 1, agentDir: 1 });
  await register(t, result.factories);
  assert.deepEqual(calls, { transport: 0, credentials: 0, browser: 0, writer: 0 });
});

test("sanitizes unexpected owner-service getter exceptions", async (t) => {
  const { options } = await fixture(t);
  const credentials = Object.defineProperty({}, "forServer", { get: () => { throw new Error("private-credential-error"); } });
  safeFailure(await prepareBackendMcpExtensions({ ...options, mcp: { ...options.mcp, credentials } }), "native-extension-preparation-failed");
});
