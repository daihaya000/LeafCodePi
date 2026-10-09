import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { sessionToolSelection, shouldUseDynamicMcpTools } from "./session-tool-selection";

let dir = "";
let session: AgentSession | undefined;
let driver: ReturnType<typeof fauxProvider>;
afterEach(() => {
  session?.dispose();
  session = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  dir = "";
});

const parameters = { type: "object", properties: {} } as never;
const stub = (name: string, exposure?: "codemode") => (api: ExtensionAPI) =>
  api.registerTool({
    name, label: name, description: `${name} fixture`, parameters,
    ...(exposure ? { exposure } : {}),
    execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
  });

// What the harness does: load, pick the SDK options, create the session, apply the initial loadout.
async function create(selection: ReturnType<typeof sessionToolSelection> | ((registered: string[]) => ReturnType<typeof sessionToolSelection>)) {
  dir = mkdtempSync(join(tmpdir(), "leafcode-tool-selection-"));
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      createCodemodeExtension({ mode: "on", models: false }),
      stub("listed"), stub("unlisted"),
      // Native MCP registers its tools like this, but only after a server connects.
      (api: ExtensionAPI) => api.on("session_start", () => stub("mcp__fixture__echo", "codemode")(api)),
    ],
  });
  await resourceLoader.reload();
  const registered = resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
  const picked = typeof selection === "function" ? selection(registered) : selection;
  driver = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(driver.provider);
  const created = await createAgentSession({
    cwd: dir, agentDir: dir, model: driver.getModel(), modelRuntime, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir),
    ...("tools" in picked ? { tools: picked.tools } : { excludeTools: picked.excludeTools }),
  });
  session = created.session;
  if ("initialActive" in picked) session.setActiveToolsByName(picked.preserveActive
    ? [...new Set([...session.getActiveToolNames(), ...picked.initialActive])]
    : picked.initialActive);
  // Like the harness: an error listener makes reload() emit session_start again.
  await session.bindExtensions({ onError: () => undefined });
  return session;
}

describe("shouldUseDynamicMcpTools", () => {
  it("needs a provider that actually registered factories", () => {
    assert.equal(shouldUseDynamicMcpTools({ active: true, factoryCount: 3 }), true);
    // An active but failed preparation registers nothing, so exclusion would only lose tools.
    assert.equal(shouldUseDynamicMcpTools({ active: true, factoryCount: 0 }), false);
    assert.equal(shouldUseDynamicMcpTools({ active: false, factoryCount: 0 }), false);
  });

  it("stays off for explicit agent and Bot allowlists", () => {
    assert.equal(shouldUseDynamicMcpTools({ active: true, factoryCount: 3, hasAgentTools: true }), false);
    assert.equal(shouldUseDynamicMcpTools({ active: true, factoryCount: 3, hasBotTools: true }), false);
  });
});

describe("sessionToolSelection", () => {
  it("keeps the SDK allowlist when native MCP is not in use", () => {
    assert.deepEqual(sessionToolSelection({ tools: ["read", "x"], dynamicMcpTools: false, registered: ["y"] }), { tools: ["read", "x"] });
  });

  it("default uses no registry snapshot or exclusion, even without native MCP", () => {
    assert.deepEqual(sessionToolSelection({ tools: ["read", "codemode"], allTools: true, dynamicMcpTools: false, registered: ["future"] }), {
      excludeTools: [], initialActive: ["read", "codemode"], preserveActive: true,
    });
  });

  it("excludes only known tools that are not wanted and never codemode", () => {
    const picked = sessionToolSelection({ tools: ["read", "tool_search", "web_search"], dynamicMcpTools: true, registered: ["web_search", "subagent", "codemode", "tool_search"] });
    assert.deepEqual(picked, {
      excludeTools: ["bash", "edit", "find", "grep", "ls", "powershell", "subagent", "write"],
      initialActive: ["read", "tool_search", "web_search"],
    });
  });
});

describe("harness wiring", () => {
  it("creates sessions from the selection and applies the initial loadout", () => {
    const source = readFileSync(new URL("../../../../backend/runtime-src/lib/pi/harness.ts", import.meta.url), "utf8");
    assert.equal(source.includes("const dynamicMcpTools = shouldUseDynamicMcpTools({"), true);
    assert.equal(source.includes("factoryCount: nativeMcp.factories.length"), true);
    assert.equal(source.includes("{ excludeTools: toolSelection.excludeTools }"), true);
    assert.equal(source.includes("const allTools = options.agentName?.trim() === DEFAULT_AGENT && !botToolAllowlist"), true);
    assert.equal(source.includes("...result.session.getActiveToolNames(), ...toolSelection.initialActive"), true);
  });
});

describe("real SDK session", () => {
  it.each([false, true])("default can call unlisted and late tools and keeps them across reload (native=%s)", async (dynamicMcpTools) => {
    const created = await create((registered) => sessionToolSelection({
      tools: ["read", "listed", "codemode", "grep", "find", "ls"], allTools: true, dynamicMcpTools, registered,
    }));
    for (const reload of [false, true]) {
      if (reload) await created.reload();
      assert.ok(created.getActiveToolNames().includes("unlisted"), "new direct extension stays active");
      assert.ok(created.getCallableToolNames().includes("mcp__fixture__echo"), "late deferred tool is callable");
      assert.ok(created.getCallableToolNames().includes("grep"));
      driver.setResponses([
        fauxAssistantMessage([fauxToolCall("codemode", { code: 'return await Promise.all([tools.unlisted({}), tools.mcp__fixture__echo({})]);' })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      await created.prompt("Call the extension tools");
      const result = [...created.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "codemode");
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.isError, false);
      const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      assert.match(text, /Script completed/);
      assert.match(text, /unlisted/);
      assert.match(text, /mcp__fixture__echo/);
    }
  }, 30_000);

  it("a hard allowlist hides codemode and later-registered MCP tools", async () => {
    const created = await create({ tools: ["read", "listed"] });
    assert.deepEqual(created.getAllTools().map((tool) => tool.name).sort(), ["listed", "read"]);
    assert.deepEqual(created.getCallableToolNames().sort(), ["listed", "read"]);
  });

  it("exclusion keeps the listed loadout, MCP tools and codemode reachable, and denies the rest", async () => {
    const created = await create((registered) => sessionToolSelection({ tools: ["read", "listed"], dynamicMcpTools: true, registered }));
    assert.deepEqual(created.getActiveToolNames().sort(), ["listed", "read"]);
    const names = created.getAllTools().map((tool) => tool.name);
    assert.equal(names.includes("unlisted"), false);
    assert.equal(names.includes("bash"), false);
    assert.equal(names.includes("codemode"), true);
    // codemode may call the active tools and the MCP tool, but not the excluded one.
    assert.deepEqual(created.getCallableToolNames().sort(), ["listed", "mcp__fixture__echo", "read"]);
    // The MCP extension activates codemode when a server needs it; that must be possible.
    created.setActiveToolsByName([...created.getActiveToolNames(), "codemode"]);
    assert.equal(created.getActiveToolNames().includes("codemode"), true);
  }, 30_000);

  it("keeps the same loadout and reachability across a session reload", async () => {
    const created = await create((registered) => sessionToolSelection({ tools: ["read", "listed"], dynamicMcpTools: true, registered }));
    created.setActiveToolsByName([...created.getActiveToolNames(), "codemode"]);
    await created.reload();
    const names = created.getAllTools().map((tool) => tool.name);
    assert.equal(names.includes("unlisted"), false);
    assert.equal(names.includes("bash"), false);
    assert.deepEqual(created.getActiveToolNames().sort(), ["codemode", "listed", "read"]);
    assert.deepEqual(created.getCallableToolNames().sort(), ["listed", "mcp__fixture__echo", "read"]);
  }, 30_000);
});
