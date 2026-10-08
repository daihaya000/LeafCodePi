import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createBackendStartup } from "./startup.mjs";
import { runtimeExternals } from "../../scripts/build-backend-runtime.mjs";
import { resolveBackendMcpNativeSession as sourceSession } from "../core/mcp-native-session.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, "..", "runtime", "runtime.bundle.mjs");

/**
 * The bundle is a build artifact (`npm run build:backend-runtime`), so these tests only run when it
 * has been built. A missing bundle means "not built yet", not a failure: the Backend still starts and
 * serves transport without a runtime.
 */
const RUNTIME_API = [
  "promptTask",
  "getTaskDetail",
  "getTaskDetailReadOnly",
  "abortTask",
  "listPendingAttention",
  "pendingPermissionForTask",
  "pendingQuestionForTask",
  "respondToPermissionPrompt",
  "respondToQuestionPrompt",
  "clearPendingAttentionForTask",
  "startBotCodeRelay",
  "ensureCodexResetScheduler",
  "applyCodePermissionSettingsToLiveTasks",
];

test("the built runtime bundle exposes the Backend's runtime API", { skip: !existsSync(BUNDLE) }, async () => {
  const runtime = await import(pathToFileURL(BUNDLE).href);
  const missing = RUNTIME_API.filter((name) => typeof runtime[name] !== "function");
  assert.deepEqual(missing, [], "every runtime entry point must be exported");
});

test("the bundle is loadable from a plain Node process", { skip: !existsSync(BUNDLE) }, async () => {
  // Importing is the assertion: the module graph must not need a Next server or a build step, and the
  // external Pi SDK must resolve from this project's own dependency.
  const runtime = await import(pathToFileURL(BUNDLE).href);
  assert.equal(typeof runtime.promptTask, "function");
  assert.equal(typeof runtime.getTaskDetail, "function");
});

test("native MCP transport classes stay external to the runtime bundle", () => {
  assert.ok(runtimeExternals().includes("@earendil-works/pi-mcp"));
});

test("startup initializes native MCP inside the real bundle, not the separate source module", { skip: !existsSync(BUNDLE) }, async (t) => {
  const runtime = await import(pathToFileURL(BUNDLE).href);
  for (const name of ["createBackendMcpNativeRuntime", "setBackendMcpNativeSessionProvider", "resolveBackendMcpNativeSession"]) assert.equal(typeof runtime[name], "function", name);
  const root = mkdtempSync(join(tmpdir(), "leafcode-mcp-bundle-startup-")); let owner;
  t.after(() => { runtime.setBackendMcpNativeSessionProvider(undefined); owner?.dispose(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "mcp.json"), '{"mcpServers":{}}', { mode: 0o600 }); writeFileSync(join(root, "bundle.json"), "{}", { mode: 0o600 });
  writeFileSync(join(root, "store.json"), '{"version":1,"projects":[],"tasks":[]}');
  assert.equal(runtime.resolveBackendMcpNativeSession(root).active, false);
  // Only pass the private initialization API: real relay/scheduler services must NOT run in this fixture.
  const api = Object.fromEntries(["createBackendMcpNativeRuntime", "setBackendMcpNativeSessionProvider"].map((name) => [name, runtime[name]]));
  const started = createBackendStartup({ dataDir: () => root, warn() {},
    loadRuntime: async () => ({ ok: true, runtime: api }),
    initializeRuntime: async (loaded) => {
      owner = loaded.createBackendMcpNativeRuntime({ agentDir: root, bundledConfigPath: join(root, "bundle.json"), homeDir: root,
        environment: {}, variables: {}, fetch: async () => { throw Error("No network"); }, openUrl() { throw Error("No browser"); }, assertProcessOwner() {},
        storageChecks: { config() {}, credentials() {} },
      });
      const prepared = await owner.prepare(); loaded.setBackendMcpNativeSessionProvider(prepared.forSession);
    },
  }); started.store.storePath = () => join(root, "store.json"); await started.startup.start();
  const selected = runtime.resolveBackendMcpNativeSession(root); assert.equal(selected.active, true); assert.equal(selected.factories.length, 3); assert.deepEqual(selected.issues, []);
  assert.equal(sourceSession(root).active, false, "an entry.mjs source-module setter would not initialize the bundled harness");
  assert.equal(existsSync(join(root, "mcp-auth.json")), false);
});

test("the built bundle exposes the current native MCP runtime API", { skip: !existsSync(BUNDLE) }, async (t) => {
  const runtime = await import(pathToFileURL(BUNDLE).href);
  for (const name of ["createBackendMcpNativeRuntime", "setBackendMcpNativeSessionProvider", "resolveBackendMcpNativeSession", "nativeMcpExtensionFactory"]) {
    assert.equal(typeof runtime[name], "function", name);
  }
  // A stale bundle without install()/snapshot made every native activation fail silently, so the
  // bundle's own shape is the contract here — not the source modules the check tool imports.
  const root = mkdtempSync(join(tmpdir(), "leafcode-native-bundle-api-"));
  t.after(() => { runtime.setBackendMcpNativeSessionProvider(undefined); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "mcp.json"), '{"mcpServers":{}}');
  writeFileSync(join(root, "bundle.json"), "{}");
  const owner = runtime.createBackendMcpNativeRuntime({
    agentDir: root, bundledConfigPath: join(root, "bundle.json"), homeDir: root,
    environment: {}, variables: {}, fetch: async () => { throw Error("No network"); }, openUrl() {},
    assertProcessOwner() {}, storageChecks: { config() {}, credentials() {} },
  });
  t.after(() => owner.dispose());
  assert.equal(typeof owner.install, "function");
  const prepared = await owner.install();
  assert.equal(typeof prepared.snapshot, "object");
  assert.equal(runtime.resolveBackendMcpNativeSession(root).active, true);
  assert.equal(runtime.resolveBackendMcpNativeSession(root).factories.length, 3);
});

test("the runtime entry source and build script exist", () => {
  const root = resolve(HERE, "..", "..");
  assert.ok(existsSync(join(root, "scripts", "build-backend-runtime.mjs")), "build script is missing");
  assert.ok(existsSync(join(root, "backend", "runtime-src", "lib", "pi", "backend-runtime-entry.ts")), "runtime entry is missing");
});
