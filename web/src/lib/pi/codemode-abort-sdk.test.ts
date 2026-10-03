import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-codemode-abort-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

/** Real SDK session driven by a scripted model. `slow` waits until its call is cancelled. */
async function create(code: string) {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const slow = { started: Promise.withResolvers<void>(), cancelled: false };
  const slowTool: ExtensionFactory = (api) => {
    api.registerTool({
      name: "slow", label: "slow", description: "Waits until it is cancelled.", parameters: Type.Object({}),
      execute: (_id, _params, signal) =>
        new Promise<never>((_resolve, reject) => {
          slow.started.resolve();
          signal?.addEventListener("abort", () => {
            slow.cancelled = true;
            reject(new Error("cancelled"));
          });
        }),
    });
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ mode: "on", models: false }), slowTool],
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
    modelRuntime, model: faux.getModel(), tools: ["slow", "codemode"],
  });
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  return { session, faux, slow };
}

function lastAssistantText(session: AgentSession): string {
  for (const message of [...session.messages].reverse()) {
    const item = message as { role?: string; content?: unknown };
    if (item.role !== "assistant") continue;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      return item.content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join("");
    }
  }
  return "";
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

describe("codemode failure paths", () => {
  it("keeps partial output after a script error and lets the turn finish", async () => {
    const { session } = await create('text("partial"); throw new Error("boom");');
    try {
      await session.prompt("実行して");
      const result = codemodeResult(session);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Script failed");
      expect(result.text).toContain("partial");
      expect(result.text).toContain("boom");
      expect(lastAssistantText(session)).toBe("done");
    } finally {
      session.dispose();
    }
  }, 30_000);

  it("cancels the nested call on abort, then accepts the next prompt", async () => {
    const { session, faux, slow } = await create('await tools.slow({}); return "finished";');
    try {
      const running = session.prompt("実行して");
      await slow.started.promise;
      await session.abort();
      await running;
      expect(slow.cancelled).toBe(true);
      expect(session.isStreaming).toBe(false);

      faux.setResponses([fauxAssistantMessage("again")]);
      await session.prompt("続けて");
      expect(lastAssistantText(session)).toBe("again");
    } finally {
      session.dispose();
    }
  }, 30_000);
});
