import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { nativeMcpExtensionFactory, setBackendMcpNativeSessionProvider } from "@backend-core/mcp-native-session.mjs";
import { sessionToolNames } from "./harness";
import { sessionToolSelection } from "./session-tool-selection";

let root = "";
let session: AgentSession | undefined;
afterEach(() => {
  session?.dispose();
  session = undefined;
  setBackendMcpNativeSessionProvider(undefined);
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  root = "";
});

async function create(tools: string[]) {
  root = mkdtempSync(join(tmpdir(), "leafcode-codemode-default-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(root, "fixture.txt"), "standalone default works", "utf8");
  // Settings must not be needed to opt in, nor switch this host to codemode-only/model access.
  const settingsManager = SettingsManager.inMemory({ packages: [], codemode: { mode: "only" } });
  const unlisted: ExtensionFactory = (api) => api.registerTool({
    name: "unlisted", label: "unlisted", description: "Not in the Code loadout",
    parameters: { type: "object", properties: {} } as never,
    execute: async () => { throw Error("must not run"); },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      nativeMcpExtensionFactory(root, createCodemodeExtension({ mode: "on", models: false })),
      unlisted,
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const picked = sessionToolSelection({ tools, dynamicMcpTools: false, registered: ["codemode", "unlisted"] });
  assert.ok("tools" in picked);
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const created = await createAgentSession({
    cwd: root, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root),
    modelRuntime, model: faux.getModel(), tools: picked.tools,
  });
  session = created.session;
  await session.bindExtensions({ onError: (error) => { throw Error(error.error); } });
  return { session, faux };
}

describe("Code default codemode without native MCP", () => {
  it("runs the default script after creation and reload, keeping direct tools and no model access", async () => {
    const { session, faux } = await create(sessionToolNames({ platform: "linux", env: {} }));
    for (const reload of [false, true]) {
      if (reload) await session.reload();
      assert.ok(session.getActiveToolNames().includes("codemode"));
      assert.ok(session.getActiveToolNames().includes("read"));
      assert.equal(session.getAllTools().filter((tool) => tool.name === "codemode").length, 1);
      assert.equal(session.getCallableToolNames().includes("unlisted"), false);
      assert.ok(session.agent.state.tools.some((tool) => tool.name === "read"), "mode on keeps direct declarations");
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("codemode", { code: 'return { data: await tools.read({ path: "fixture.txt" }), models: typeof models, excluded: "unlisted" in tools };' })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      await session.prompt("Read fixture.txt with a script");
      const result = [...session.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "codemode");
      assert.ok(result && result.role === "toolResult");
      const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      assert.equal(result.isError, false, text);
      assert.match(text, /standalone default works/);
      assert.match(text, /"models":"undefined"/);
      assert.match(text, /"excluded":false/);
    }
  }, 30_000);

  it("does not grant codemode to a restricted agent, even after reload", async () => {
    const { session } = await create(sessionToolNames({ agentTools: ["read"] }));
    for (const reload of [false, true]) {
      if (reload) await session.reload();
      assert.deepEqual(session.getActiveToolNames(), ["read"]);
      assert.equal(session.getAllTools().some((tool) => tool.name === "codemode"), false);
    }
  }, 30_000);
});
