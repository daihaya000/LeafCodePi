import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  readSessionConversation: vi.fn(),
  resolveAutoAgent: vi.fn(),
  promptTask: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/direct-session", () => ({
  readSessionConversation: mocks.readSessionConversation,
}));
vi.mock("@/lib/auto-agent", () => ({ resolveAutoAgent: mocks.resolveAutoAgent }));
vi.mock("@/lib/pi/harness", () => ({
  jsonError: mocks.jsonError,
  promptTask: mocks.promptTask,
}));

import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[id]/prompt", () => {
  beforeEach(() => {
    mocks.getTask.mockReset();
    mocks.readSessionConversation.mockReset();
    mocks.resolveAutoAgent.mockReset();
    mocks.promptTask.mockReset();
    mocks.getTask.mockReturnValue({
      id: "task-1",
      status: "idle",
      agent: "build",
      sessionFile: "C:\\sessions\\task-1.jsonl",
    });
    mocks.readSessionConversation.mockReturnValue([
      { role: "user", text: "APIを作る" },
      { role: "assistant", text: "設計を確認します" },
    ]);
    mocks.resolveAutoAgent.mockResolvedValue("reviewer");
    mocks.promptTask.mockResolvedValue({ id: "task-1", agent: "reviewer" });
  });

  it("resolves Auto from the persisted conversation and passes the real agent", async () => {
    const response = await POST(
      request({ prompt: "差分をレビューして", agent: AUTO_AGENT_VALUE }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.readSessionConversation).toHaveBeenCalledWith("C:\\sessions\\task-1.jsonl");
    expect(mocks.resolveAutoAgent).toHaveBeenCalledWith({
      conversation: [
        { role: "user", text: "APIを作る" },
        { role: "assistant", text: "設計を確認します" },
      ],
      prompt: "差分をレビューして",
      hasImages: false,
    });
    expect(mocks.promptTask).toHaveBeenCalledWith(
      "task-1",
      "差分をレビューして",
      undefined,
      expect.objectContaining({ agent: "reviewer" }),
    );
  });

  it("forwards Auto model authority with the resolved agent", async () => {
    mocks.resolveAutoAgent.mockResolvedValue("build");

    const response = await POST(
      request({
        prompt: "徹底的に調査して",
        agent: AUTO_AGENT_VALUE,
        auto: true,
        model: "openai-codex::gpt-5.6-sol",
        thinkingLevel: "medium",
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.promptTask).toHaveBeenCalledWith(
      "task-1",
      "徹底的に調査して",
      undefined,
      expect.objectContaining({
        agent: "build",
        model: "openai-codex::gpt-5.6-sol",
        thinkingLevel: "medium",
      }),
    );
  });

  it("keeps the current agent for a stale Auto request during a running turn", async () => {
    mocks.getTask.mockReturnValue({
      id: "task-1",
      status: "working",
      agent: "build",
      sessionFile: "C:\\sessions\\task-1.jsonl",
    });

    const response = await POST(
      request({ prompt: "続けて", agent: AUTO_AGENT_VALUE, streamingBehavior: "steer" }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAutoAgent).not.toHaveBeenCalled();
    expect(mocks.promptTask).toHaveBeenCalledWith(
      "task-1",
      "続けて",
      undefined,
      expect.objectContaining({ agent: "build", streamingBehavior: "steer" }),
    );
  });

  it("rejects a non-string agent value", async () => {
    const response = await POST(
      request({ prompt: "作業", agent: null }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });
});
