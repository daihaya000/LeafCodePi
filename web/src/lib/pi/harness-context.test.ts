import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import { codeOnDemandPrompt } from "@/lib/agents-md";
import { sessionExtensionFactories, sessionResourceOptions } from "./harness";

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
