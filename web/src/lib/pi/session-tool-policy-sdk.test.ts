import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, createCodemodeExtension, createToolSearchExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { applySubagentPermission, sessionExtensionFactories } from "./harness";
import { captureNativeToolSearch, type NativeToolSearch } from "./deferred-tools";
import { attachCodeToolPolicy, codeToolAllowed, type CodeToolPolicy } from "./session-tool-policy";

let root = "";
let session: AgentSession | undefined;
afterEach(() => {
  session?.dispose();
  session = undefined;
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

async function fixture(reactivate = false, agentTools?: string[]) {
  root = mkdtempSync(join(tmpdir(), "leafcode-code-tool-policy-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const policy: CodeToolPolicy = { subagent: "deny" };
  const nativeToolSearch: NativeToolSearch = {};
  let runs = 0;
  const stubs: ExtensionFactory = (api) => {
    for (const name of ["subagent", "future_tool"]) api.registerTool({
      name, label: name, description: name === "subagent" ? "Launch a subagent" : "A future extension",
      parameters: Type.Object({}),
      execute: async () => { if (name === "subagent") runs++; return { content: [{ type: "text", text: "ran " + name }], details: undefined }; },
    });
  };
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    extensionFactories: [
      stubs,
      captureNativeToolSearch((api) => {
        createCodemodeExtension({ mode: "on", models: false })(api);
        createToolSearchExtension()(api);
      }, nativeToolSearch, (name) => codeToolAllowed(policy, name)),
      ...sessionExtensionFactories({ agentDir, hasBotSkills: false, allTools: true, codeToolPolicy: policy, nativeToolSearch, getExtensions: () => [] }).slice(0, 2),
      (api) => { if (reactivate) api.on("before_agent_start", () => { api.setActiveTools([...api.getActiveTools(), "subagent"]); }); },
    ],
  });
  await resourceLoader.reload();
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const created = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(root), modelRuntime, model: faux.getModel(),
    ...(agentTools ? { tools: agentTools } : { excludeTools: [] }) });
  session = created.session;
  attachCodeToolPolicy(session, policy);
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  await session.bindExtensions({ onError: (error) => { throw Error(error.error); } });
  return { session, policy, faux, runs: () => runs };
}

function result(session: AgentSession, name: string): string {
  const message = [...session.messages].reverse().find((entry) => entry.role === "toolResult" && entry.toolName === name);
  expect(message?.role).toBe("toolResult");
  return message?.role === "toolResult" ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
}

it("default inheritance does not override subagent deny, including search, codemode and reload", async () => {
  const { session, faux, runs } = await fixture();
  for (const reload of [false, true]) {
    if (reload) await session.reload();
    expect(session.getAllTools().some((tool) => tool.name === "subagent")).toBe(true); // registration is not permission
    expect(session.getActiveToolNames()).not.toContain("subagent");
    expect(session.getActiveToolNames()).toContain("future_tool");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "subagent" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("codemode", { code: 'return { subagent: "subagent" in tools, future: await tools.future_tool({}) };' })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("subagent", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Try delegation");
    expect(runs()).toBe(0);
    expect(session.getActiveToolNames()).not.toContain("subagent");
    expect(result(session, "codemode")).toContain('"subagent":false');
    expect(result(session, "codemode")).toContain("ran future_tool");
  }
}, 30_000);

it("an explicit agent subagent allowlist cannot override the Code deny setting", async () => {
  const { session, faux, runs } = await fixture(false, ["subagent", "codemode", "tool_search", "future_tool"]);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: 'return { allowed: "subagent" in tools };' })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("subagent", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("Try allowed agent delegation while Code forbids it");
  expect(result(session, "codemode")).toContain('"allowed":false');
  expect(runs()).toBe(0);
}, 30_000);

it("live allow/deny updates affect codemode and survive reload without rebuilding the registry", async () => {
  const { session, faux, runs, policy } = await fixture();
  applySubagentPermission(session, "allow");
  expect(policy.subagent).toBe("allow");
  for (const permission of ["allow", "deny", "allow"] as const) {
    applySubagentPermission(session, permission);
    await session.reload();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: 'try { return await tools.subagent({}); } catch (error) { return "blocked: " + error.message; }' })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const before = runs();
    await session.prompt(permission);
    expect(runs() - before).toBe(permission === "allow" ? 1 : 0);
    expect(result(session, "codemode")).toContain(permission === "allow" ? "ran subagent" : "blocked:");
  }
}, 30_000);

it("the execution gate rejects delegation even if another extension reactivates it", async () => {
  const { session, faux, runs } = await fixture(true);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("subagent", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("Try a reactivated tool");
  expect(result(session, "subagent")).toContain("disabled by the Code");
  expect(runs()).toBe(0);
}, 30_000);
