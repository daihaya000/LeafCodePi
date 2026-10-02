import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { prepareBackendMcpConfigLoader } from "./mcp-native-config-loader.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, user = { mcpServers: {} }, bundled = { mcpServers: {} }) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-mcp-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledConfigPath = join(root, "bundled.json");
  await writeFile(bundledConfigPath, JSON.stringify(bundled));
  if (user !== undefined) await writeFile(join(root, "mcp.json"), JSON.stringify(user));
  return { root, options: { agentDir: root, bundledConfigPath }, userPath: join(root, "mcp.json") };
}
const failWithoutSecrets = (result, code) => {
  assert.equal(result.ok, false);
  assert.equal(result.loadConfig, null);
  if (code) assert.equal(result.issues[0].code, code);
  assert.equal(JSON.stringify(result).includes("private"), false);
};

test("owner snapshot merges defaults/overrides, preserves native fields and exact source bytes/revisions", async (t) => {
  const bundled = { mcpServers: {
    inherited: { command: "fixture", description: "bundled" },
    override: { command: "fixture", disabled: true, env: { SECRET: "private-secret" } },
  }, autoEnableCodemode: true };
  const user = { mcpServers: {
    override: { enabled: true, exposure: "codemode-deferred", toolExposure: { get: "deferred" } },
    oauth: { url: "https://example.invalid/mcp", auth: "oauth", httpTransport: "streamable-http", protocolVersion: "auto",
      oauth: { clientId: "fixture", clientSecret: "${PRIVATE_OAUTH_SECRET}" }, description: "日本語" },
    provider: { url: "https://example.invalid/provider", auth: { provider: "fixture" }, enabled: false },
  }, autoEnableCodemode: false };
  const { root, options, userPath } = await fixture(t, user, bundled);
  const bytes = Buffer.from("\uFEFF" + JSON.stringify(user, null, 2).replaceAll("\n", "\r\n") + "\r\n", "utf8");
  await writeFile(userPath, bytes);
  const bundledBytes = await readFile(options.bundledConfigPath);
  const before = await readdir(root);
  const result = await prepareBackendMcpConfigLoader(options);
  assert.equal(result.ok, true);
  assert.equal(result.sourceSha256, sha256(bytes));
  assert.equal(result.bundledSha256, sha256(bundledBytes));
  assert.equal(result.serverCount, 4);
  const snapshot = result.loadConfig({ cwd: "private-project", projectTrusted: true });
  assert.equal(snapshot.autoEnableCodemode, false);
  assert.deepEqual(snapshot.errors, []);
  const entries = Object.fromEntries(snapshot.servers.map((entry) => [entry.name, entry]));
  assert.equal(entries.inherited.config.enabled, false);
  assert.equal(entries.override.config.enabled, true);
  assert.equal(entries.override.config.exposure, "codemode");
  assert.deepEqual(entries.override.config.toolExposure, { get: "deferred" });
  assert.deepEqual(entries.provider.config.auth, { provider: "fixture" });
  assert.equal(entries.oauth.config.oauth.clientSecret, "${PRIVATE_OAUTH_SECRET}");
  for (const entry of snapshot.servers) { assert.equal(entry.scope, "global"); assert.equal(entry.source, userPath); }
  assert.deepEqual(await readFile(userPath), bytes);
  assert.deepEqual(await readFile(options.bundledConfigPath), bundledBytes);
  assert.deepEqual(await readdir(root), before);
  assert.equal(JSON.stringify(result).includes("private-secret"), false); // Secrets only accessible through the internal callback.
});

test("loadConfig clones every result, ignores project/cwd and does not implicitly reread on reload", async (t) => {
  const { root, options, userPath } = await fixture(t, { mcpServers: { fixture: { command: "fixture", env: { SECRET: "private-secret" } } } });
  await mkdir(join(root, "project", ".pi"), { recursive: true });
  await writeFile(join(root, "project", ".pi", "mcp.json"), JSON.stringify({ mcpServers: { injected: { command: "private-command" } } }));
  const result = await prepareBackendMcpConfigLoader(options);
  assert.equal(result.ok, true);
  const first = result.loadConfig({ cwd: join(root, "project"), projectTrusted: true });
  first.servers[0].config.env.SECRET = "changed";
  first.servers.length = 0;
  first.errors.push("private-error");
  const second = result.loadConfig();
  assert.equal(second.servers[0].config.env.SECRET, "private-secret");
  assert.deepEqual(second.errors, []);
  await writeFile(userPath, JSON.stringify({ mcpServers: {} }));
  assert.equal(result.loadConfig().servers.length, 1);
  assert.equal((await prepareBackendMcpConfigLoader(options)).loadConfig().servers.length, 0);
});

test("missing user config imports all defaults disabled without creating user files", async (t) => {
  const { root, options, userPath } = await fixture(t, {}, { mcpServers: { fixture: { command: "fixture", enabled: true } } });
  await rm(userPath);
  const before = await readdir(root);
  const result = await prepareBackendMcpConfigLoader(options);
  assert.equal(result.ok, true);
  assert.equal(result.sourceSha256, null);
  assert.equal(result.loadConfig().servers[0].config.enabled, false);
  assert.deepEqual(await readdir(root), before);
});

test("URL substitution is explicit and refuses missing/inherited/command variables even when disabled", async (t) => {
  const { options, userPath } = await fixture(t, { mcpServers: { fixture: { url: "${LEAFCODE_NATIVE_LOADER_URL}", enabled: false } } });
  const bytes = await readFile(userPath);
  const previous = process.env.LEAFCODE_NATIVE_LOADER_URL;
  process.env.LEAFCODE_NATIVE_LOADER_URL = "https://private-env.example.invalid/mcp";
  t.after(() => { if (previous === undefined) delete process.env.LEAFCODE_NATIVE_LOADER_URL; else process.env.LEAFCODE_NATIVE_LOADER_URL = previous; });
  failWithoutSecrets(await prepareBackendMcpConfigLoader(options), "unresolved-url-variable");
  failWithoutSecrets(await prepareBackendMcpConfigLoader({ ...options, urlVariables: Object.create({ LEAFCODE_NATIVE_LOADER_URL: "https://private-inherited.invalid" }) }), "unresolved-url-variable");
  failWithoutSecrets(await prepareBackendMcpConfigLoader({ ...options, urlVariables: { LEAFCODE_NATIVE_LOADER_URL: "!private-command" } }), "unsupported-url-command");
  failWithoutSecrets(await prepareBackendMcpConfigLoader({ ...options, urlVariables: null }), "invalid-url-variables");
  const result = await prepareBackendMcpConfigLoader({ ...options, urlVariables: { LEAFCODE_NATIVE_LOADER_URL: "https://example.invalid/mcp" } });
  assert.equal(result.ok, true);
  assert.equal(result.loadConfig().servers[0].config.url, "https://example.invalid/mcp");
  assert.equal(result.loadConfig().servers[0].config.enabled, false);
  assert.deepEqual(await readFile(userPath), bytes);
});

test("malformed files/encoding/shapes reject the whole snapshot without logs, values or writes", async (t) => {
  const { root, options, userPath } = await fixture(t);
  const warn = t.mock.method(console, "warn", () => { throw new Error("Unexpected config logging"); });
  for (const [bytes, code] of [[Buffer.from([0xff, 0xfe, 0x41]), "user-invalid-encoding"], [Buffer.from('{"private-secret"'), "user-invalid-json"],
    [Buffer.from("null"), "invalid-document"], [Buffer.from('{"mcpServers":[]}'), "invalid-server-map"]]) {
    await writeFile(userPath, bytes);
    failWithoutSecrets(await prepareBackendMcpConfigLoader(options), code);
    assert.deepEqual(await readFile(userPath), bytes);
  }
  assert.equal(warn.mock.callCount(), 0);
  assert.deepEqual((await readdir(root)).sort(), ["bundled.json", "mcp.json"]);
  await writeFile(options.bundledConfigPath, "private-secret");
  failWithoutSecrets(await prepareBackendMcpConfigLoader(options), "bundled-invalid-json");
});

test("unsupported legacy/SDK settings reject all entries, without partial activation or secret errors", async (t) => {
  const { options, userPath } = await fixture(t);
  for (const config of [{ url: "https://example.invalid", bearerTokenStore: true }, { url: "https://example.invalid", headersStore: true },
    { url: "https://example.invalid", type: "sse" }, { command: "fixture", timeout: -1 }, { command: "fixture", exposure: "private-invalid" }]) {
    await writeFile(userPath, JSON.stringify({ mcpServers: { safe: { command: "fixture" }, fixture: { ...config, enabled: false } } }));
    const bytes = await readFile(userPath);
    failWithoutSecrets(await prepareBackendMcpConfigLoader(options));
    assert.deepEqual(await readFile(userPath), bytes);
  }
});

test("bad owner paths/options and non-regular inputs fail closed", async (t) => {
  const { root, options, userPath } = await fixture(t);
  for (const input of [null, [], {}, { ...options, agentDir: "relative" }, { ...options, bundledConfigPath: "relative" },
    { ...options, configPath: "private-path" }, Object.create(options)]) {
    failWithoutSecrets(await prepareBackendMcpConfigLoader(input), "invalid-loader-options");
  }
  await rm(userPath);
  await mkdir(userPath);
  failWithoutSecrets(await prepareBackendMcpConfigLoader(options), "user-not-regular-file");
  failWithoutSecrets(await prepareBackendMcpConfigLoader({ ...options, bundledConfigPath: join(root, "missing") }), "bundled-unreadable");
  failWithoutSecrets(await prepareBackendMcpConfigLoader({ ...options, bundledConfigPath: root }), "bundled-not-regular-file");
});

test("real built-in MCP/codemode/tool_search factories accept the prepared callback without session/transport/credential activity", async (t) => {
  const { root, options, userPath } = await fixture(t, { mcpServers: {
    stdio: { command: process.execPath, args: ["-e", "throw Error('private-command')"], env: { SECRET: "!private-command" } },
    http: { url: "https://example.invalid/mcp", headers: { "X-Key": "!private-header-command" }, oauth: { clientSecret: "!private-oauth-command" } },
  } });
  const result = await prepareBackendMcpConfigLoader(options);
  assert.equal(result.ok, true);
  let transports = 0;
  let credentials = 0;
  let loadCalls = 0;
  const sdkRoot = join(root, "sdk");
  await mkdir(sdkRoot);
  const loader = new DefaultResourceLoader({ cwd: sdkRoot, agentDir: sdkRoot,
    settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension({
      loadConfig: (ctx) => { loadCalls++; return result.loadConfig(ctx); },
      createTransport: () => { transports++; throw new Error("Transport must not start"); },
      credentials: new Proxy({}, { get: () => { credentials++; throw new Error("Credentials must not be accessed"); } }),
      openUrl: () => { throw new Error("Browser must not open"); },
      updateConfig: () => { throw new Error("Configuration must not be written"); },
    })],
  });
  const bytes = await readFile(userPath);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const extensions = loader.getExtensions().extensions;
  assert.equal(extensions.some((extension) => extension.commands.has("mcp")), true);
  assert.equal(extensions.some((extension) => extension.tools.has("codemode")), true);
  assert.equal(extensions.some((extension) => extension.tools.has("tool_search")), true);
  assert.equal(loadCalls, 0); // Native MCP loads only when session_start is dispatched, not at registration.
  assert.equal(transports, 0);
  assert.equal(credentials, 0);
  assert.deepEqual(await readFile(userPath), bytes);
  assert.deepEqual(await readdir(sdkRoot), []);
});
