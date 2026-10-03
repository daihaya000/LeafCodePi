import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeMcpExtensionFactory } from "@backend-core/mcp-native-session.mjs";
import todowriteExtension from "../../../../extensions/leafcode-todowrite/index";
import { registerJevNoulJudge } from "./jev-noul-judge";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-codemode-gate-"));
  registerJevNoulJudge(null);
});
afterEach(() => {
  registerJevNoulJudge(null);
  rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

/** Real SDK session driven by a scripted model: it issues one `codemode` call with `code`. */
async function run(code: string) {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(root, "a.txt"), "hello");
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  let writes = 0;
  const workTool: ExtensionFactory = (api) => {
    api.registerTool({
      name: "probe_write", label: "probe_write", description: "Pretend to change something.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => {
        writes += 1;
        return { content: [{ type: "text", text: "changed" }], details: undefined };
      },
    });
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    extensionFactories: [
      nativeMcpExtensionFactory(root, createCodemodeExtension({ mode: "on", models: false })),
      workTool,
      todowriteExtension as unknown as ExtensionFactory,
    ],
  });
  await resourceLoader.reload();
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd: root, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root),
    modelRuntime, model: faux.getModel(), tools: ["read", "probe_write", "todowrite", "codemode"],
  });
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  await session.prompt("a.txt の中身を調べて");
  return { session, writes: () => writes };
}

function codemodeResult(session: AgentSession): { text: string; isError: boolean } {
  for (const message of session.messages) {
    const result = message as { role?: string; toolName?: string; isError?: boolean; content?: unknown };
    if (result.role !== "toolResult" || result.toolName !== "codemode" || !Array.isArray(result.content)) continue;
    const text = result.content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
    return { text, isError: result.isError === true };
  }
  throw new Error("codemode produced no result");
}

describe("ToDo gate with codemode", () => {
  it("judges the nested calls, so a script that only reads is not stopped as a whole", async () => {
    const { session } = await run('const text = await tools.read({ path: "a.txt" }); return text.includes("hello");');
    try {
      const result = codemodeResult(session);
      expect(result.text).toContain("Script completed");
      expect(result.text).toContain("true");
      expect(result.isError).toBe(false);
    } finally {
      session.dispose();
    }
  }, 30_000);

  it("stops a nested change before it runs, and the script sees the gate's reason", async () => {
    const { session, writes } = await run(
      'try { await tools.probe_write({ path: "a.txt" }); return "ran"; } catch (error) { return "blocked: " + error.message; }',
    );
    try {
      expect(writes()).toBe(0);
      expect(codemodeResult(session).text).toMatch(/blocked: .*ToDo/);
    } finally {
      session.dispose();
    }
  }, 30_000);
});
