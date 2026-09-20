import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it } from "vitest";
import { codeOnDemandPrompt } from "@/lib/agents-md";
import { applyBotTools, sessionExtensionFactories, sessionResourceOptions, sessionToolNames } from "./harness";

let root: string;
let agentDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-context-review-"));
  agentDir = join(root, "agent");
  mkdirSync(agentDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function loader(noContextFiles: boolean, botToolAllowlist?: string[]) {
  const result = new DefaultResourceLoader({
    cwd: root, agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    ...sessionResourceOptions({ agentDir, noContextFiles, botToolAllowlist, agentAppendSystemPrompt: undefined, appendSystemPrompt: undefined }),
  });
  await result.reload();
  return result;
}

it("loads optional schemas on demand through the real SDK and keeps an agent allowlist", async () => {
  const settingsManager = SettingsManager.inMemory();
  const extensionFactories = sessionExtensionFactories({ agentDir, hasBotSkills: false, getExtensions: () => [] });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [
      (api) => {
        // Stub external execution only; registry, lifecycle and activation are real.
        for (const name of ["web_search", "fetch_content", "get_search_content", "intercom"]) {
          api.registerTool({ name, label: name, description: name, parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "not called" }], details: {} }),
          });
        }
      },
      ...extensionFactories.slice(0, 2),
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: root, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root),
    tools: sessionToolNames({ agentTools: ["read", "web_search", "get_search_content"] }),
  });
  try {
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    expect(session.getActiveToolNames()).toEqual(["read", "tool_search"]);
    const search = session.agent.state.tools.find(tool => tool.name === "tool_search")!;
    await search.execute("tc", { query: "get_search_content" });
    expect(session.getActiveToolNames()).toEqual(["read", "tool_search", "get_search_content"]);
    await search.execute("tc", { query: "fetch_content" });
    expect(session.getActiveToolNames()).not.toContain("fetch_content");
    expect(session.getAllTools().some(tool => tool.name === "fetch_content")).toBe(false);
    await session.reload();
    expect(session.getActiveToolNames()).toEqual(["read", "tool_search"]);
    // Bot application also hides permitted optional schemas when a loader exists,
    // but leaves them callable when the loader is explicitly disabled.
    applyBotTools(session, ["read", "tool_search", "web_search"]);
    expect(session.getActiveToolNames()).toEqual(["read", "tool_search"]);
    applyBotTools(session, ["read", "web_search"]);
    expect(session.getActiveToolNames()).toEqual(["read", "web_search"]);
  } finally {
    session.dispose();
  }
});

it("keeps SDK APPEND_SYSTEM.md discovery alongside Code global sources", async () => {
  writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "extra system rules");
  const code = await loader(false);
  expect(code.getAppendSystemPrompt()).toEqual(["extra system rules"]);
  writeFileSync(join(agentDir, "SOUL.md"), "tone rules");
  writeFileSync(join(agentDir, "USER.md"), "user profile");
  await code.reload();
  expect(code.getAppendSystemPrompt()).toEqual(["extra system rules", "tone rules", "user profile"]);
  expect((await loader(true, ["read"])).getAppendSystemPrompt()).not.toContain("tone rules");
});

it("keeps global AGENTS.md for a Code persona with project context disabled, but not for Bot", async () => {
  writeFileSync(join(agentDir, "AGENTS.md"), "global rules");
  writeFileSync(join(root, "AGENTS.md"), "project rules");
  const code = await loader(true);
  expect(code.getAgentsFiles().agentsFiles).toEqual([{ path: join(agentDir, "AGENTS.md"), content: "global rules" }]);
  writeFileSync(join(agentDir, "AGENTS.md"), "updated global rules");
  await code.reload();
  expect(code.getAgentsFiles().agentsFiles[0]?.content).toBe("updated global rules");
  expect((await loader(true, ["read"])).getAgentsFiles().agentsFiles).toEqual([]);
});

it("does not duplicate global AGENTS.md when SDK context discovery is enabled", async () => {
  writeFileSync(join(agentDir, "AGENTS.md"), "global rules");
  expect((await loader(false)).getAgentsFiles().agentsFiles.filter(f => f.content === "global rules")).toHaveLength(1);
});

it("advertises only present regular reference files without their bodies", () => {
  expect(codeOnDemandPrompt(agentDir)).toBe("");
  mkdirSync(join(agentDir, "TOOLS.md"));
  writeFileSync(join(agentDir, "DESIGN.md"), "");
  writeFileSync(join(agentDir, "WORKFLOW.md"), "private workflow body");
  const prompt = codeOnDemandPrompt(agentDir);
  expect(prompt).toContain("WORKFLOW.md");
  expect(prompt).not.toContain("TOOLS.md");
  expect(prompt).not.toContain("DESIGN.md");
  expect(prompt).not.toContain("private workflow body");
});

it("refreshes reference discovery each turn and respects Bot/read permissions", () => {
  const handlers = new Map<string, (event: { systemPrompt: string }) => { systemPrompt: string }>();
  let activeTools = ["read"];
  const api = {
    on: (name: string, handler: (event: { systemPrompt: string }) => { systemPrompt: string }) => handlers.set(name, handler),
    getActiveTools: () => activeTools,
  } as unknown as ExtensionAPI;
  // Only the runtime-context factory is needed; no model/network call.
  const input = { agentDir, hasBotSkills: false, getExtensions: () => [] };
  sessionExtensionFactories(input)[0](api);
  const prompt = () => handlers.get("before_agent_start")!({ systemPrompt: "base" }).systemPrompt;
  expect(prompt()).not.toContain("leafcode_on_demand_context");
  writeFileSync(join(agentDir, "WORKFLOW.md"), "private workflow body");
  expect(prompt()).toContain("WORKFLOW.md");
  expect(prompt()).not.toContain("private workflow body");
  activeTools = [];
  expect(prompt()).not.toContain("WORKFLOW.md");
  activeTools = ["read"];
  sessionExtensionFactories({ ...input, botToolAllowlist: ["read"] })[0](api);
  expect(prompt()).not.toContain("WORKFLOW.md");
  sessionExtensionFactories(input)[0](api);
  rmSync(join(agentDir, "WORKFLOW.md"));
  expect(prompt()).not.toContain("leafcode_on_demand_context");
});
