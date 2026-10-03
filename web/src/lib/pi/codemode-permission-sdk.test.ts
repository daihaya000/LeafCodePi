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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import permissionGate from "../../../../extensions/leafcode-permission-gate/index";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-codemode-permission-"));
  mkdirSync(join(root, "data"), { recursive: true });
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

/** Real SDK session driven by a scripted model that issues one `codemode` call. */
async function run(mode: "allow" | "deny", code: string) {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(root, "data", "permission-gate.json"), JSON.stringify({ mode }), "utf8");
  writeFileSync(join(root, ".env"), "SECRET=1", "utf8");
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  let shellRuns = 0;
  // Stands in for the shell so nothing real can run; the gate sees the same tool name.
  const shell: ExtensionFactory = (api) => {
    api.registerTool({
      name: "powershell", label: "powershell", description: "Pretend to run a command.",
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => {
        shellRuns += 1;
        return { content: [{ type: "text", text: "ran" }], details: undefined };
      },
    });
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    extensionFactories: [
      createCodemodeExtension({ mode: "on", models: false }),
      shell,
      permissionGate as unknown as ExtensionFactory,
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
    modelRuntime, model: faux.getModel(), tools: ["read", "powershell", "codemode"],
  });
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  await session.prompt("調べて");
  return { session, shellRuns: () => shellRuns };
}

function codemodeText(session: AgentSession): string {
  for (const message of session.messages) {
    const result = message as { role?: string; toolName?: string; content?: unknown };
    if (result.role !== "toolResult" || result.toolName !== "codemode" || !Array.isArray(result.content)) continue;
    return result.content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
  }
  throw new Error("codemode produced no result");
}

const attempt = (call: string) => `try { const r = await ${call}; return "ok: " + String(r).slice(0, 40); } catch (error) { return "blocked: " + error.message; }`;

describe("permission gate with codemode", () => {
  it("lets a nested shell call run when the mode allows it", async () => {
    const { session, shellRuns } = await run("allow", attempt('tools.powershell({ command: "Write-Output ok" })'));
    try {
      expect(codemodeText(session)).toContain("ok: ran");
      expect(shellRuns()).toBe(1);
    } finally {
      session.dispose();
    }
  }, 30_000);

  it("blocks a nested shell call in deny mode before it runs", async () => {
    const { session, shellRuns } = await run("deny", attempt('tools.powershell({ command: "Write-Output ok" })'));
    try {
      expect(shellRuns()).toBe(0);
      expect(codemodeText(session)).toMatch(/blocked: .*Shell execution blocked/);
    } finally {
      session.dispose();
    }
  }, 30_000);

  it("blocks a nested read of a protected file", async () => {
    const { session } = await run("allow", attempt('tools.read({ path: ".env" })'));
    try {
      const text = codemodeText(session);
      expect(text).toMatch(/blocked: .*protected/i);
      expect(text).not.toContain("SECRET=1");
    } finally {
      session.dispose();
    }
  }, 30_000);
});
