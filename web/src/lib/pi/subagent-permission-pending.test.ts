import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, createToolSearchExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, it } from "vitest";
import { applySubagentPermission } from "./harness";
import { attachCodeToolPolicy, preservingPendingToolNames, registerCodeToolPolicy, type CodeToolPolicy } from "./session-tool-policy";

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
async function createSessionFixture(exposure: "direct" | "deferred" = "direct", mode: "baseline" | "raw" | "helper" | "policy" = "baseline") {
  const policy: CodeToolPolicy = { subagent: "deny" };
  dir = mkdtempSync(join(tmpdir(), "leafcode-subagent-pending-"));
  let connected = true;
  let waitedForConnection = false;
  let resolveConnected: (() => void) | undefined;
  const serverConnected = new Promise<void>((resolve) => { resolveConnected = resolve; });
  // Deferred tools never auto-activate on registration: restoration truly depends on pending names.
  const registerLate = (api: ExtensionAPI) => api.registerTool({
    name: "mcp__fixture__echo", label: "mcp__fixture__echo", description: "Late MCP tool",
    exposure, parameters, execute: async () => ({ content: [{ type: "text", text: "echo" }], details: {} }),
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
    }), createToolSearchExtension(), (api: ExtensionAPI) => {
      if (mode === "policy") registerCodeToolPolicy(api, policy);
      if (mode === "raw") api.on("session_start", () => {
        api.setActiveTools(api.getActiveTools().filter((name) => name !== "subagent"));
      });
    }],
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
  if (mode === "policy") attachCodeToolPolicy(session, policy);
  session.setActiveToolsByName([...session.getActiveToolNames(), "tool_search"]);
  await session.bindExtensions({ onError: (error) => { throw Error(error.error); } });
  return {
    activateDeferred: async () => {
      assert.equal(session!.getActiveToolNames().includes("mcp__fixture__echo"), false);
      driver.setResponses([
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "mcp__fixture__echo" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      await session!.prompt("Find the MCP echo tool");
      assert.equal(session!.getActiveToolNames().includes("mcp__fixture__echo"), true);
    },
    pending: () => [...(session as unknown as { _pendingToolNames?: Set<string> })._pendingToolNames ?? []],
    disconnect: () => { connected = false; },
    connect: () => { connected = true; resolveConnected?.(); },
  };
}

describe("pending restoration across SDK reload", () => {
  for (const exposure of ["direct", "deferred"] as const) {
    for (const mode of ["baseline", "raw", "helper", "policy"] as const) {
      it(`${exposure}: ${mode} ${mode === "raw" ? "drops" : "preserves"} the connecting tool`, async () => {
        const fixture = await createSessionFixture(exposure, mode);
        if (exposure === "deferred") await fixture.activateDeferred();
        fixture.disconnect();
        await session!.reload();
        if (mode === "helper") applySubagentPermission(session!, "deny");
        assert.equal(fixture.pending().includes("mcp__fixture__echo"), mode !== "raw");
        assert.equal(session!.getActiveToolNames().includes("subagent"), mode === "baseline");
        assert.equal(fixture.pending().includes("subagent"), false);
        fixture.connect();
        await new Promise((resolve) => setImmediate(resolve));
        // Direct registration masks pending loss. Deferred exposure makes that loss observable.
        assert.equal(session!.getActiveToolNames().includes("mcp__fixture__echo"), exposure === "direct" || mode !== "raw");
        assert.equal(session!.getActiveToolNames().includes("subagent"), mode === "baseline");
      }, 30_000);
    }
  }
});

describe("policy pending guards", () => {
  it.each(["session_start", "before_agent_start"])("%s preserves pending names while enforcing deny", (event) => {
    let active = ["subagent", "read"];
    const state = { _pendingToolNames: new Set(["mcp__late__tool", "subagent"]), getActiveToolNames: () => active };
    const handlers = new Map<string, () => void>();
    const api = {
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; state._pendingToolNames.clear(); },
      on: (name: string, handler: () => void) => { handlers.set(name, handler); },
    } as unknown as ExtensionAPI;
    const policy: CodeToolPolicy = { subagent: "deny" };
    attachCodeToolPolicy(state as unknown as AgentSession, policy);
    registerCodeToolPolicy(api, policy);
    handlers.get(event)!();
    assert.deepEqual(active, ["read"]);
    assert.deepEqual([...state._pendingToolNames], ["mcp__late__tool"]);
  });

  it("re-reads a replaced pending set without restoring active or denied names", () => {
    const state = {
      _pendingToolNames: new Set(["mcp__late__tool", "read", "subagent"]),
      getActiveToolNames: () => ["read"],
    };
    preservingPendingToolNames(state as unknown as AgentSession, "subagent", () => {
      state._pendingToolNames = new Set(["subagent"]);
    });
    assert.deepEqual([...state._pendingToolNames], ["mcp__late__tool"]);
  });

  it.each([undefined, null, [], {}])("still applies deny when the SDK-private field is unavailable: %j", (pending) => {
    let applied = false;
    const state = { _pendingToolNames: pending, getActiveToolNames: () => [] };
    preservingPendingToolNames(state as unknown as AgentSession, "subagent", () => { applied = true; });
    assert.equal(applied, true);
  });

  it("enforces deny even without an attached session", () => {
    let active = ["read", "subagent"];
    const handlers = new Map<string, () => void>();
    const api = {
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; },
      on: (name: string, handler: () => void) => { handlers.set(name, handler); },
    } as unknown as ExtensionAPI;
    registerCodeToolPolicy(api, { subagent: "deny" });
    handlers.get("session_start")!();
    assert.deepEqual(active, ["read"]);
  });
});

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