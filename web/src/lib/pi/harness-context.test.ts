import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { codeOnDemandPrompt, compactSdkDocumentation } from "@/lib/agents-md";
import { loadAgentDefinition } from "@/lib/agents";
import { filterExtensionsByState, writeExtensionsState } from "@/lib/extensions";
import { OPENAI_FAST_MODE_SETTING_KEY } from "@/lib/openai-fast-mode";
import { setSetting } from "@/lib/pi/web-settings";
import { applyBotTools, sessionExtensionFactories, sessionResourceOptions, sessionToolNames, settingsManagerExcludingReplacedPackages } from "./harness";

let root: string;
let agentDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-context-review-"));
  agentDir = join(root, "agent");
  mkdirSync(agentDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

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

it("keeps permitted tools directly callable through the real SDK without widening an agent allowlist", async () => {
  const settingsManager = SettingsManager.inMemory();
  const agentTools = ["read", "web_search", "get_search_content", "tool_search"];
  const extensionFactories = sessionExtensionFactories({ agentDir, agentToolAllowlist: agentTools, hasBotSkills: false, getExtensions: () => [] });
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
    tools: sessionToolNames({ agentTools }),
  });
  try {
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    expect(session.getActiveToolNames()).toEqual(agentTools);
    const original = session.systemPrompt;
    const compacted = compactSdkDocumentation(original);
    expect(compacted.length).toBeLessThan(original.length);
    expect(compacted).toContain("read the relevant local .md files completely");
    for (const line of original.split("\n").filter(line => /^- (Main documentation|Additional docs|Examples):/.test(line))) {
      expect(compacted).toContain(line);
    }
    expect(compactSdkDocumentation(`Custom persona\n${original}`)).toBe(`Custom persona\n${original}`);
    expect(compactSdkDocumentation(`${original}\n\nUser rules remain intact`).endsWith("User rules remain intact")).toBe(true);
    const search = session.agent.state.tools.find(tool => tool.name === "tool_search")!;
    await search.execute("tc", { query: "get_search_content" });
    expect(session.getActiveToolNames()).toEqual(agentTools);
    await search.execute("tc", { query: "fetch_content" });
    expect(session.getActiveToolNames()).not.toContain("fetch_content");
    expect(session.getAllTools().some(tool => tool.name === "fetch_content")).toBe(false);
    await session.reload();
    expect(session.getActiveToolNames()).toEqual(agentTools);
    applyBotTools(session, ["read", "tool_search", "web_search"]);
    expect(session.getActiveToolNames()).toEqual(["read", "tool_search", "web_search"]);
    applyBotTools(session, ["read", "web_search"]);
    expect(session.getActiveToolNames()).toEqual(["read", "web_search"]);
  } finally {
    session.dispose();
  }
});

it("allows the default agent to call session_search directly and after reload", async () => {
  const definition = loadAgentDefinition("default", agentDir);
  expect(definition).toBeDefined();
  const agentTools = definition?.tools;
  expect(agentTools).toBeUndefined();
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [
      (api) => api.registerTool({
        name: "session_search", label: "Session Search", description: "Search previous sessions",
        parameters: Type.Object({ query: Type.String() }),
        execute: async (_id, { query }) => ({ content: [{ type: "text", text: query }], details: {} }),
      }),
      ...sessionExtensionFactories({ agentDir, agentToolAllowlist: agentTools, allTools: true, hasBotSkills: false, getExtensions: () => [] }).slice(0, 2),
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: root, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root),
    excludeTools: [],
  });
  try {
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const tool = session.agent.state.tools.find(({ name }) => name === "session_search");
      expect(tool).toBeDefined();
      expect((await tool!.execute("tc", { query: "学習を止めて 停止して" })).content).toEqual([
        { type: "text", text: "学習を止めて 停止して" },
      ]);
      await session.reload();
    }
  } finally {
    session.dispose();
  }
});

it.each([
  { tools: ["read", "tool_search", "web_search"] },
  { tools: ["read", "web_search"] },
  { tools: [] },
])("keeps Bot permissions after SDK reload: $tools", async ({ tools: initial }) => {
  let allowed: readonly string[] = initial;
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [
      (api) => {
        for (const name of ["web_search", "fetch_content", "mcp", "room_handoff"]) {
          api.registerTool({ name, label: name, description: name, parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "not called" }], details: {} }),
          });
        }
      },
      ...sessionExtensionFactories({
        agentDir, hasBotSkills: false, getExtensions: () => [],
        botToolAllowlist: initial, getBotToolAllowlist: () => allowed,
      }).slice(0, 2),
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: root, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root),
    tools: sessionToolNames({ botTools: initial, roomHandoffTool: true }),
  });
  try {
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    applyBotTools(session, allowed);
    const expected = session.getActiveToolNames();
    expect(expected).toContain("room_handoff");
    if (initial.includes("web_search")) expect(expected).toContain("web_search");
    expect(expected).not.toContain("write");
    await session.reload();
    expect(session.getActiveToolNames()).toEqual(expected);

    // Permissions applied while this session is alive must survive reload too.
    allowed = ["read", "tool_search", "fetch_content"];
    applyBotTools(session, allowed);
    await session.reload();
    const search = session.agent.state.tools.find(tool => tool.name === "tool_search")!;
    await search.execute("tc", { query: "web_search" });
    expect(session.getActiveToolNames()).not.toContain("web_search");
    await search.execute("tc", { query: "fetch_content" });
    expect(session.getActiveToolNames()).toEqual(["room_handoff", "read", "tool_search", "fetch_content"]);
  } finally {
    session.dispose();
  }
});

it("does not import a disabled package extension before filtering it", async () => {
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  writeExtensionsState({ disabled: { ponytail: true } });
  const packageDir = join(agentDir, "git", "github.com", "owner", "ponytail");
  const entry = join(packageDir, "pi-extension", "index.js");
  const marker = join(root, "imported.txt");
  mkdirSync(join(packageDir, "pi-extension"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ pi: { extensions: ["./pi-extension/index.js"] } }));
  writeFileSync(entry, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); export default () => {};`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["git:github.com/owner/ponytail"] }));
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settingsManagerExcludingReplacedPackages(pi, SettingsManager.create(root, agentDir), new Set(), agentDir),
    extensionsOverride: (base) => ({ ...base, extensions: filterExtensionsByState(base.extensions, undefined, agentDir) }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().extensions.some((extension) => extension.path === entry)).toBe(false);
  expect(existsSync(marker)).toBe(false);
  writeExtensionsState({ disabled: {} });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().extensions.some((extension) => extension.path === entry)).toBe(true);
  expect(existsSync(marker)).toBe(true);
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
  expect(prompt()).not.toContain("on_demand_context");
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
  expect(prompt()).not.toContain("on_demand_context");
});

it("adds the OpenAI priority service tier per request only while Fast mode is on", () => {
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  const handlers = new Map<string, (event: { payload: unknown }, ctx: { model?: { provider: string } }) => unknown>();
  const api = {
    on: (name: string, handler: (event: { payload: unknown }, ctx: { model?: { provider: string } }) => unknown) => handlers.set(name, handler),
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  sessionExtensionFactories({ agentDir, hasBotSkills: false, getExtensions: () => [] })[0](api);
  const request = (provider: string) => handlers.get("before_provider_request")!({ payload: { model: "gpt-5" } }, { model: { provider } });
  expect(request("openai")).toBeUndefined();
  setSetting(OPENAI_FAST_MODE_SETTING_KEY, "1");
  expect(request("openai")).toEqual({ model: "gpt-5", service_tier: "priority" });
  expect(request("openai-codex")).toEqual({ model: "gpt-5", service_tier: "priority" });
  expect(request("anthropic")).toBeUndefined();
  setSetting(OPENAI_FAST_MODE_SETTING_KEY, null);
  expect(request("openai")).toBeUndefined();
});
