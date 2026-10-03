import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { sessionToolSelection } from "./session-tool-selection";

let dir = "";
let session: AgentSession | undefined;
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
  const model = {
    id: "fixture", name: "Fixture", provider: "openai", api: "openai-completions", baseUrl: "https://example.invalid",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 1024,
  } as never;
  const created = await createAgentSession({
    cwd: dir, agentDir: dir, model, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir),
    ...("tools" in picked ? { tools: picked.tools } : { excludeTools: picked.excludeTools }),
  });
  session = created.session;
  if ("initialActive" in picked) session.setActiveToolsByName(picked.initialActive);
  await session.bindExtensions({});
  return session;
}

describe("sessionToolSelection", () => {
  it("keeps the SDK allowlist when native MCP is not in use", () => {
    assert.deepEqual(sessionToolSelection({ tools: ["read", "x"], dynamicMcpTools: false, registered: ["y"] }), { tools: ["read", "x"] });
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
    const source = readFileSync(new URL("./harness.ts", import.meta.url), "utf8");
    assert.equal(source.includes("nativeMcp.active && !agentOptions?.tools && !options.botTools"), true);
    assert.equal(source.includes("{ excludeTools: toolSelection.excludeTools }"), true);
    assert.equal(source.includes("setActiveToolsByName(toolSelection.initialActive)"), true);
  });
});

describe("real SDK session", () => {
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
});
