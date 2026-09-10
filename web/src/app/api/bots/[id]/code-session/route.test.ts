import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  patchBot: vi.fn(),
  getTask: vi.fn(),
  listTasks: vi.fn(),
  getProject: vi.fn(),
  createBotCodeTask: vi.fn(),
  continueBotCodeTask: vi.fn(),
  stopBotCodeTask: vi.fn(),
  getTaskSummariesWithTodoProgress: vi.fn(),
  goalLoopCommand: vi.fn(),
  promptTask: vi.fn(),
  reconcileOrphanedWorkingTasks: vi.fn(),
  withBotCodeSessionLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500,
  })),
}));

vi.mock("@/lib/bots", () => ({ getBot: mocks.getBot, patchBot: mocks.patchBot }));
vi.mock("@/lib/task-runtime-lease", () => ({ reconcileOrphanedWorkingTasks: mocks.reconcileOrphanedWorkingTasks }));
vi.mock("@/lib/bot-code-session-lock", () => ({ withBotCodeSessionLock: mocks.withBotCodeSessionLock }));
vi.mock("@/lib/store", () => ({ getProject: mocks.getProject, getTask: mocks.getTask, listTasks: mocks.listTasks }));
vi.mock("@/lib/pi/harness", () => ({
  createBotCodeTask: mocks.createBotCodeTask,
  continueBotCodeTask: mocks.continueBotCodeTask,
  stopBotCodeTask: mocks.stopBotCodeTask,
  getTaskSummariesWithTodoProgress: mocks.getTaskSummariesWithTodoProgress,
  goalLoopCommand: mocks.goalLoopCommand,
  promptTask: mocks.promptTask,
  jsonError: mocks.jsonError,
}));

import { GET, PATCH, POST } from "./route";

const bot = {
  id: "bot-1",
  name: "Builder",
  model: null,
  thinkingLevel: null,
  permissionMode: null,
  codeSessionTaskId: null,
};

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/bots/bot-1/code-session", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBot.mockReturnValue({ ...bot });
  mocks.patchBot.mockImplementation((_id: string, patch: Record<string, unknown>) => ({ ...bot, ...patch }));
  mocks.getProject.mockReturnValue({ id: "project-1", archived: false });
  mocks.getTask.mockReturnValue(undefined);
  mocks.listTasks.mockReturnValue([]);
  mocks.getTaskSummariesWithTodoProgress.mockResolvedValue([]);
  mocks.goalLoopCommand.mockResolvedValue({ id: "loop-1", status: "paused", maxTurns: 3, turnCount: 1 });
  mocks.createBotCodeTask.mockResolvedValue({ id: "code-1", status: "working" });
  mocks.stopBotCodeTask.mockResolvedValue({ id: "code-1", status: "idle" });
  mocks.promptTask.mockResolvedValue({ id: "code-1", status: "working" });
});

describe("Bot Code session control", () => {
  it("starts one project-backed Code task and links it to the Bot", async () => {
    const response = await POST(request("POST", { projectId: "project-1", prompt: "修正して" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(response.status).toBe(200);
    // The Bot outbox owns the run, so its result is reported back into the conversation.
    expect(mocks.createBotCodeTask).toHaveBeenCalledWith("bot-1", {
      projectId: "project-1",
      prompt: "修正して",
      permissionMode: "ask",
    });
    expect(mocks.patchBot).not.toHaveBeenCalledWith("bot-1", { codeSessionTaskId: "code-1" });
  });

  it("starts a new Code task without a project", async () => {
    const response = await POST(request("POST", { projectId: null, prompt: "調査して" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.createBotCodeTask).toHaveBeenCalledWith("bot-1", {
      projectId: null,
      prompt: "調査して",
      permissionMode: "ask",
    });
    expect(mocks.patchBot).not.toHaveBeenCalledWith("bot-1", { codeSessionTaskId: "code-1" });
  });

  it("does not inherit the Bot chat model for a Code task", async () => {
    mocks.getBot.mockReturnValue({ ...bot, model: "bot-model", thinkingLevel: "high" });

    const response = await POST(request("POST", { projectId: "project-1", prompt: "Autoで修正" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.createBotCodeTask).toHaveBeenCalledWith("bot-1", {
      projectId: "project-1",
      prompt: "Autoで修正",
      permissionMode: "ask",
    });
  });

  it("starts a Code task with Goal Loop settings", async () => {
    const goalLoop = {
      acceptance: ["テストが通ること"],
      maxTurns: 3,
      cooldownSeconds: 5,
      forceFullRun: true,
    };
    const response = await POST(request("POST", {
      projectId: "project-1",
      prompt: "修正して",
      goalLoop,
    }), { params: Promise.resolve({ id: "bot-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.createBotCodeTask).toHaveBeenCalledWith("bot-1", expect.objectContaining({
      projectId: "project-1",
      goalLoop,
    }));
  });

  it("rejects an unknown project before creating a Code task", async () => {
    mocks.getProject.mockReturnValue(undefined);

    const response = await POST(request("POST", { projectId: "missing", prompt: "起動" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(response.status).toBe(404);
    expect(mocks.createBotCodeTask).not.toHaveBeenCalled();
  });

  it("rejects an archived project before creating a Code task", async () => {
    mocks.getProject.mockReturnValue({ id: "archived", archived: true });

    const response = await POST(request("POST", { projectId: "archived", prompt: "起動" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "アーカイブ済みのプロジェクトではCodeセッションを起動できません" });
    expect(mocks.createBotCodeTask).not.toHaveBeenCalled();
  });

  it("clears an archived linked task", async () => {
    mocks.getBot.mockReturnValue({ ...bot, codeSessionTaskId: "code-archived" });
    mocks.getTask.mockReturnValue({ id: "code-archived", status: "archived" });

    const response = await PATCH(request("PATCH", { action: "clear" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: null });
    expect(mocks.patchBot).toHaveBeenCalledWith("bot-1", { codeSessionTaskId: null });
  });

  it("allows a second Code task for the same Bot", async () => {
    mocks.getBot.mockReturnValue({ ...bot, codeSessionTaskId: "code-0" });
    mocks.getTask.mockReturnValue({ id: "code-0", status: "working", botId: "bot-1" });

    const response = await POST(request("POST", { projectId: "project-1", prompt: "もう一つ" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.createBotCodeTask).toHaveBeenCalled();
  });

  it("prompts and aborts the linked task through the existing harness", async () => {
    mocks.getBot.mockReturnValue({ ...bot, codeSessionTaskId: "code-1" });
    mocks.getTask.mockReturnValue({ id: "code-1", status: "idle", botId: "bot-1" });
    mocks.continueBotCodeTask.mockResolvedValue({ id: "code-1", status: "working", botId: "bot-1" });

    const promptResponse = await PATCH(request("PATCH", { action: "prompt", prompt: "続けて" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });
    const abortResponse = await PATCH(request("PATCH", { action: "abort" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(promptResponse.status).toBe(200);
    // 追撃もoutbox経由で登録し、結果をBot会話へ返す。
    expect(mocks.continueBotCodeTask).toHaveBeenCalledWith("bot-1", "code-1", "続けて");
    expect(mocks.promptTask).not.toHaveBeenCalled();
    expect(abortResponse.status).toBe(200);
    // A panel stop is final: the owning request is marked before the task is aborted.
    expect(mocks.stopBotCodeTask).toHaveBeenCalledWith("bot-1", "code-1");
  });

  it("controls Goal Loop only for a Code task owned by this Bot", async () => {
    mocks.getTask.mockReturnValue({ id: "code-1", status: "idle", botId: "bot-1" });

    const response = await PATCH(request("PATCH", {
      action: "goal-loop",
      taskId: "code-1",
      goalLoopAction: "resume",
      maxTurns: 3,
    }), { params: Promise.resolve({ id: "bot-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.goalLoopCommand).toHaveBeenCalledWith("code-1", { action: "resume", maxTurns: 3 });
  });

  it("rejects Goal Loop control for another Bot's Code task", async () => {
    mocks.getTask.mockReturnValue({ id: "code-2", status: "idle", botId: "bot-2" });

    const response = await PATCH(request("PATCH", {
      action: "goal-loop",
      taskId: "code-2",
      goalLoopAction: "pause",
    }), { params: Promise.resolve({ id: "bot-1" }) });

    expect(response.status).toBe(404);
    expect(mocks.goalLoopCommand).not.toHaveBeenCalled();
  });

  it("reports the Bot's Code tasks without hydrating the session", async () => {
    mocks.getTaskSummariesWithTodoProgress.mockResolvedValue([
      { id: "code-1", status: "idle", kind: "code", botId: "bot-1" },
      { id: "bot-1", status: "idle", kind: "bot", botId: "bot-1" },
      { id: "code-2", status: "idle", kind: "code", botId: "bot-2" },
    ]);

    const response = await GET(request("GET"), { params: Promise.resolve({ id: "bot-1" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tasks: [{ id: "code-1", status: "idle", kind: "code", botId: "bot-1" }] });
  });
});