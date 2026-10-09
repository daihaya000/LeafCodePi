import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { bundledExtensionEntries } from "@/lib/extensions";
import { RESUME_CANCEL_COMMAND } from "../../../../extensions/leafcode-session-resume/index";
import registerTodowrite from "@extensions/leafcode-todowrite/index";
import { resumeReservationFromBranch } from "@shared/session-resume";

const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});

async function createSession(options: { persist?: boolean; todos?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-session-resume-sdk-"));
  roots.push(cwd);
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory();
  const extensionPath = fileURLToPath(new URL("../../../../extensions/leafcode-session-resume/index.ts", import.meta.url));
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [extensionPath],
    extensionFactories: options.todos ? [registerTodowrite] : [],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const faux = fauxProvider();
  const reserve = () => fauxAssistantMessage([
    fauxToolCall("session_resume", { action: "schedule", afterSeconds: 1, message: "比較処理の完了を確認する" }),
  ], { stopReason: "toolUse" });
  faux.setResponses([reserve(), fauxAssistantMessage("確認を予約した"), fauxAssistantMessage("比較処理は完了した")]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd, agentDir, resourceLoader: loader, settingsManager,
    sessionManager: options.persist ? SessionManager.create(cwd, join(agentDir, "sessions")) : SessionManager.inMemory(cwd),
    modelRuntime, model: faux.getModel(), tools: options.todos ? ["session_resume", "todowrite"] : ["session_resume"],
  });
  sessions.push(session);
  const errors: string[] = [];
  await session.bindExtensions({ onError: (error) => { errors.push(error.error); } });
  return { session, faux, errors, cwd, agentDir, loader, settingsManager, modelRuntime };
}
function wakeMessages(session: AgentSession) {
  return session.messages.filter((message) => message.role === "custom" && message.customType === "leafcode-session-resume-trigger");
}
function declaredTools(context: TranscriptContext) {
  const names = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
  }
  return names;
}

it("discovers the bundled extension and actually starts a new SDK turn without user input", async () => {
  vi.stubEnv("LEAFCODE_PI_EXTENSIONS_DIR", fileURLToPath(new URL("../../../../extensions", import.meta.url)));
  expect(bundledExtensionEntries().some((entry) => entry.name === "leafcode-session-resume")).toBe(true);
  const { session, faux, errors } = await createSession();
  expect(session.getActiveToolNames()).toContain("session_resume");
  await session.prompt("処理を開始し、後で結果を確認する");
  expect(faux.state.callCount).toBe(2);
  await vi.waitFor(() => expect(session.getLastAssistantText()).toBe("比較処理は完了した"), { timeout: 3_000, interval: 20 });
  expect(faux.state.callCount).toBe(3);
  expect(wakeMessages(session)).toHaveLength(1);
  expect(errors).toEqual([]);
});

it("restores the timer across a real jiti session.reload and delivers only once", async () => {
  const { session, faux, errors } = await createSession();
  await session.prompt("確認を予約する");
  await session.reload();
  await vi.waitFor(() => expect(session.getLastAssistantText()).toBe("比較処理は完了した"), { timeout: 3_000, interval: 20 });
  await session.reload();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(faux.state.callCount).toBe(3);
  expect(wakeMessages(session)).toHaveLength(1);
  expect(errors).toEqual([]);
});

it("survives real SDK disposal without shutdown and restores an overdue disk reservation once", async () => {
  const { session: old, faux, errors, cwd, agentDir, loader, settingsManager, modelRuntime } = await createSession({ persist: true });
  await old.prompt("確認を予約する");
  const sessionFile = old.sessionFile!;
  old.dispose(); // Unlike reload/host shutdown, SDK dispose emits no extension shutdown.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(faux.state.callCount).toBe(2);
  expect(wakeMessages(old)).toHaveLength(0);
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime, model: faux.getModel(),
    sessionManager: SessionManager.open(sessionFile), tools: ["session_resume"],
  });
  sessions.push(session);
  await session.bindExtensions({ onError: (error) => { errors.push(error.error); } });
  await vi.waitFor(() => expect(session.getLastAssistantText()).toBe("比較処理は完了した"), { timeout: 3_000, interval: 20 });
  expect(faux.state.callCount).toBe(3);
  expect(wakeMessages(session)).toHaveLength(1);
  expect(resumeReservationFromBranch(session.sessionManager.getBranch(), session.sessionId)?.status).toBe("fired");
  await session.reload();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(faux.state.callCount).toBe(3);
  expect(errors).toEqual([]);
});

it.each(["completed", "cancelled"])("can schedule and wake after the real ToDo gate closes with %s todos", async (status) => {
  const { session, faux, errors } = await createSession({ todos: true });
  const todo = { content: "Background check", priority: "high" };
  const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  faux.setResponses([
    (context) => {
      expect(declaredTools(context).has("session_resume")).toBe(true);
      return tool("todowrite", { todos: [{ ...todo, status: "in_progress" }] });
    },
    tool("todowrite", { todos: [{ ...todo, status }] }),
    (context) => {
      expect(declaredTools(context).has("session_resume")).toBe(true);
      return tool("session_resume", { action: "schedule", afterSeconds: 1, message: "比較処理の完了を確認する" });
    },
    fauxAssistantMessage("確認を予約した"), fauxAssistantMessage("比較処理は完了した"),
  ]);
  await session.prompt("結果確認を予約してユーザーへ戻る");
  expect(session.messages.filter((message) => message.role === "toolResult").every((message) => !message.isError)).toBe(true);
  await vi.waitFor(() => expect(session.getLastAssistantText()).toBe("比較処理は完了した"), { timeout: 3_000, interval: 20 });
  expect(faux.state.callCount).toBe(5);
  expect(wakeMessages(session)).toHaveLength(1);
  expect(errors).toEqual([]);
});

it("cancels through the model-free command used by the host's Stop path", async () => {
  const { session, faux, errors } = await createSession();
  await session.prompt("確認を予約する");
  const runner = session.extensionRunner;
  const command = runner.getCommand(RESUME_CANCEL_COMMAND);
  expect(command).toBeDefined();
  await command!.handler("", runner.createCommandContext());
  await session.reload();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(faux.state.callCount).toBe(2);
  expect(wakeMessages(session)).toHaveLength(0);
  expect(errors).toEqual([]);
});

it("cancels a pending reservation when a new user task arrives", async () => {
  const { session, faux, errors } = await createSession();
  await session.prompt("確認を予約する");
  await session.prompt("別の作業を始める");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(faux.state.callCount).toBe(3);
  expect(wakeMessages(session)).toHaveLength(0);
  expect(errors).toEqual([]);
});
