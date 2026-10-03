import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, it } from "vitest";
import { applySubagentPermission } from "./harness";

const parameters = { type: "object", properties: {} } as never;
let dir = "";
let session: AgentSession | undefined;
afterEach(() => {
  session?.dispose();
  session = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  dir = "";
});

/** Stands in for a native MCP server: its tool registers only when the test releases it. */
async function createSessionFixture() {
  dir = mkdtempSync(join(tmpdir(), "leafcode-subagent-pending-"));
  let connected = true;
  let waitedForConnection = false;
  let resolveConnected: (() => void) | undefined;
  const serverConnected = new Promise<void>((resolve) => { resolveConnected = resolve; });
  // Direct exposure, like an MCP server configured `exposure: "direct"`: its tools are declared to the
// model, so a reload leaves them pending until the server re-registers them.
const registerLate = (api: ExtensionAPI) => api.registerTool({
    name: "mcp__fixture__echo", label: "mcp__fixture__echo", description: "Late MCP tool",
    parameters, execute: async () => ({ content: [{ type: "text", text: "echo" }], details: {} }),
  });
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(api: ExtensionAPI) => {
      // A native MCP server registers its tools when it finishes connecting, and re-registers them
      // after every reload. While it is still connecting its name must stay pending.
      api.on("session_start", () => {
        if (connected) { registerLate(api); return; }
        if (waitedForConnection) return;
        waitedForConnection = true;
        void serverConnected.then(() => registerLate(api));
      });
    }, (api: ExtensionAPI) => api.registerTool({
      name: "subagent", label: "subagent", description: "Delegate", parameters,
      execute: async () => ({ content: [{ type: "text", text: "delegated" }], details: {} }),
    })],
  });
  await resourceLoader.reload();
  const driver = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(driver.provider);
  const created = await createAgentSession({
    cwd: dir, agentDir: dir, model: driver.getModel(), modelRuntime, resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(dir), excludeTools: [],
  });
  session = created.session;
  await session.bindExtensions({ onError: () => undefined });
  // Like the Code loadout for a session that allows delegation.
  session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), "subagent"])]);
  return {
    pending: () => [...(session as unknown as { _pendingToolNames?: Set<string> })._pendingToolNames ?? []],
    disconnect: () => { connected = false; },
    connect: () => { connected = true; resolveConnected?.(); },
  };
}

describe("applySubagentPermission", () => {
  it("denying subagent keeps a connecting MCP tool pending so it still activates", async () => {
    const fixture = await createSessionFixture();
    // Reload with the server still connecting: its name is active-but-unregistered, hence pending.
    fixture.disconnect();
    await session!.reload();
    assert.equal(fixture.pending().includes("mcp__fixture__echo"), true);

    applySubagentPermission(session!, "deny");
    assert.equal(session!.getActiveToolNames().includes("subagent"), false);
    assert.equal(fixture.pending().includes("mcp__fixture__echo"), true);
    assert.equal(fixture.pending().includes("subagent"), false, "a denied tool must not come back as pending");

    fixture.connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session!.getActiveToolNames().includes("mcp__fixture__echo"), true);
  }, 30_000);

  it("allowing subagent adds it back and does not drop pending names", async () => {
    const fixture = await createSessionFixture();
    fixture.disconnect();
    await session!.reload();
    applySubagentPermission(session!, "deny");
    assert.equal(session!.getActiveToolNames().includes("subagent"), false);

    applySubagentPermission(session!, "allow");
    assert.equal(session!.getActiveToolNames().includes("subagent"), true);
    assert.equal(fixture.pending().includes("mcp__fixture__echo"), true);

    fixture.connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session!.getActiveToolNames().includes("mcp__fixture__echo"), true);
  }, 30_000);
});