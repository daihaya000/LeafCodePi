import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  patchBot: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  abortTask: vi.fn(),
  promptTask: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500,
  })),
}));

vi.mock("@/lib/bots", () => ({ getBot: mocks.getBot, patchBot: mocks.patchBot }));
vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/pi/harness", () => ({
  createTask: mocks.createTask,
  abortTask: mocks.abortTask,
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
  mocks.getTask.mockReturnValue(undefined);
  mocks.createTask.mockResolvedValue({ id: "code-1", status: "working" });
  mocks.abortTask.mockResolvedValue({ id: "code-1", status: "idle" });
  mocks.promptTask.mockResolvedValue({ id: "code-1", status: "working" });
});

describe("Bot Code session control", () => {
  it("starts one project-backed Code task and links it to the Bot", async () => {
    const response = await POST(request("POST", { projectId: "project-1", prompt: "修正して" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.createTask).toHaveBeenCalledWith({
      projectId: "project-1",
      prompt: "修正して",
      permissionMode: "ask",
    });
    expect(mocks.patchBot).toHaveBeenCalledWith("bot-1", { codeSessionTaskId: "code-1" });
  });

  it("does not create a second linked task", async () => {
    mocks.getBot.mockReturnValue({ ...bot, codeSessionTaskId: "code-0" });
    mocks.getTask.mockReturnValue({ id: "code-0", status: "working" });

    const response = await POST(request("POST", { projectId: "project-1", prompt: "もう一つ" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(response.status).toBe(409);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("prompts and aborts the linked task through the existing harness", async () => {
    mocks.getBot.mockReturnValue({ ...bot, codeSessionTaskId: "code-1" });
    mocks.getTask.mockReturnValue({ id: "code-1", status: "idle" });

    const promptResponse = await PATCH(request("PATCH", { action: "prompt", prompt: "続けて" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });
    const abortResponse = await PATCH(request("PATCH", { action: "abort" }), {
      params: Promise.resolve({ id: "bot-1" }),
    });

    expect(promptResponse.status).toBe(200);
    expect(mocks.promptTask).toHaveBeenCalledWith("code-1", "続けて");
    expect(abortResponse.status).toBe(200);
    expect(mocks.abortTask).toHaveBeenCalledWith("code-1");
  });

  it("reports the linked task without hydrating the session", async () => {
    mocks.getBot.mockReturnValue({ ...bot, codeSessionTaskId: "code-1" });
    mocks.getTask.mockReturnValue({ id: "code-1", status: "idle" });

    const response = await GET(request("GET"), { params: Promise.resolve({ id: "bot-1" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "code-1", status: "idle" } });
  });
});