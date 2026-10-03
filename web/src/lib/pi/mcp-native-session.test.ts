import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, vi } from "vitest";
import { createCodemodeExtension, createToolSearchExtension, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createBackendMcpNativeRuntime } from "@backend-core/mcp-native-runtime.mjs";
import { bundledPathsForNativeMcp, nativeMcpExtensionFactory, resolveBackendMcpNativeSession, setBackendMcpNativeSessionProvider } from "@backend-core/mcp-native-session.mjs";
import { replacedUpstreamPackages } from "@backend-core/replaced-packages.mjs";
import { basenameKey, bundledExtensionEntries } from "../extensions";
import { sessionExtensionsOverride } from "./harness";

const bundledRoot = fileURLToPath(new URL("../../../../extensions/", import.meta.url));
let agentDir = "";
afterEach(() => {
  setBackendMcpNativeSessionProvider(undefined);
  vi.unstubAllEnvs();
  if (agentDir) rmSync(agentDir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  agentDir = "";
});

// Same selection steps as harness createSession: provider -> bundled paths -> names stay complete.
async function loadWith(mode: "off" | "ok" | "failed") {
  agentDir = mkdtempSync(join(tmpdir(), "leafcode-native-session-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(agentDir, "data"));
  vi.stubEnv("LEAFCODE_PI_EXTENSIONS_DIR", bundledRoot);
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  writeFileSync(join(agentDir, "bundle.json"), "{}");
  if (mode === "ok") {
    const runtime = createBackendMcpNativeRuntime({
      agentDir, bundledConfigPath: join(agentDir, "bundle.json"), homeDir: agentDir, environment: {}, variables: {},
      fetch: async () => { throw new Error("No network"); }, openUrl() { throw new Error("No browser"); }, assertProcessOwner() {},
      storageChecks: { config() {}, credentials() {} },
    });
    const prepared = await runtime.prepare();
    setBackendMcpNativeSessionProvider((cwd: string) => prepared.forSession(cwd));
  }
  if (mode === "failed") setBackendMcpNativeSessionProvider(() => ({ ok: false, issues: [{ code: "mcp-config-unreadable" }], factories: null }));
  const bundled = bundledExtensionEntries();
  const nativeMcp = resolveBackendMcpNativeSession(agentDir);
  const loadedBundled = bundledPathsForNativeMcp(bundled, nativeMcp.active);
  const index = { names: new Set(bundled.map((entry) => entry.name)), paths: new Set(loadedBundled.map((entry) => entry.filePath)) };
  const loader = new DefaultResourceLoader({
    cwd: agentDir, agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    additionalExtensionPaths: loadedBundled.map((entry) => entry.filePath),
    extensionFactories: [nativeMcpExtensionFactory(agentDir, (api) => {
      createCodemodeExtension({ mode: "on", models: false })(api);
      createToolSearchExtension()(api);
    })],
    extensionsOverride: sessionExtensionsOverride(index),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  return { nativeMcp, loaded: loader.getExtensions(), index };
}

describe("native MCP session selection", () => {
  it("loads standalone codemode by default without activating MCP (the adapter is retired)", async () => {
    const { nativeMcp, loaded } = await loadWith("off");
    assert.equal(nativeMcp.active, false);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.some((extension) => basenameKey(extension.path) === "leafcode-mcp-adapter"), false);
    assert.equal(loaded.extensions.filter((extension) => extension.tools.has("codemode")).length, 1);
    assert.equal(loaded.extensions.filter((extension) => extension.tools.has("tool_search")).length, 1);
  }, 30_000);

  it("loads native MCP/codemode/tool_search and keeps the retired MCP extensions out", async () => {
    const { nativeMcp, loaded, index } = await loadWith("ok");
    assert.equal(nativeMcp.active, true); assert.equal(nativeMcp.factories.length, 3);
    assert.deepEqual(loaded.errors, []);
    assert.equal(replacedUpstreamPackages(index.names).has("pi-mcp-adapter"), true);
    assert.equal(loaded.extensions.some((extension) => basenameKey(extension.path) === "leafcode-mcp-adapter"), false);
    assert.equal(loaded.extensions.filter((extension) => extension.tools.has("codemode")).length, 1);
    assert.equal(loaded.extensions.some((extension) => extension.tools.has("tool_search")), true);
    // The harness must resolve the provider per loader run (and per reload), not capture its factories.
    const harnessSource = readFileSync(new URL("./harness.ts", import.meta.url), "utf8");
    assert.match(harnessSource, /nativeMcpExtensionFactory\(\s*options\.cwd, \(api\) => \{\s*pi\.createCodemodeExtension\(\{ mode: "on", models: false \}\)\(api\)/);
    assert.ok(harnessSource.includes("pi.createToolSearchExtension()(api)"));
    assert.equal(harnessSource.includes("...nativeMcp.factories"), false);
  }, 30_000);

  it("keeps standalone codemode when a native provider fails preparation, without activating MCP", async () => {
    const { nativeMcp, loaded } = await loadWith("failed");
    assert.equal(nativeMcp.active, true);
    assert.deepEqual(nativeMcp.factories, []);
    assert.deepEqual(nativeMcp.issues.map((issue) => issue.code), ["mcp-config-unreadable"]);
    assert.deepEqual(loaded.errors, []);
    // Code keeps its script tool; the retired adapter and every MCP surface stay absent.
    assert.equal(loaded.extensions.filter((extension) => extension.tools.has("codemode")).length, 1);
    assert.equal(loaded.extensions.some((extension) => basenameKey(extension.path) === "leafcode-mcp-adapter"), false);
    assert.equal(loaded.extensions.some((extension) => [...extension.tools.keys()].some((name) => name.startsWith("mcp__"))), false);
  }, 30_000);
});
