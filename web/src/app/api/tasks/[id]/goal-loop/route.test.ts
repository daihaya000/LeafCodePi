import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  readSessionConversation: vi.fn(),
  resolveAutoAgent: vi.fn(),
  resolveAutoModel: vi.fn(),
  goalLoopCommand: vi.fn(),
  goalLoopState: vi.fn(),
  setTaskAgent: vi.fn(),
  setTaskModel: vi.fn(),
  setTaskThinkingLevel: vi.fn(),
  validateTaskModelSelection: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status:
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : 500,
  })),
}));

vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/direct-session", () => ({
  readSessionConversation: mocks.readSessionConversation,
}));
vi.mock("@/lib/auto-agent", () => ({ resolveAutoAgent: mocks.resolveAutoAgent }));
vi.mock("@/lib/pi/harness", () => ({
  goalLoopCommand: mocks.goalLoopCommand,
  goalLoopState: mocks.goalLoopState,
  jsonError: mocks.jsonError,
  resolveAutoModel: mocks.resolveAutoModel,
  setTaskAgent: mocks.setTaskAgent,
  setTaskModel: mocks.setTaskModel,
  setTaskThinkingLevel: mocks.setTaskThinkingLevel,
  validateTaskModelSelection: mocks.validateTaskModelSelection,
}));

import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/goal-loop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[id]/goal-loop", () => {
  let task: { id: string; status: string; agent: string; sessionFile: string };

  beforeEach(() => {
    task = {
      id: "task-1",
      status: "idle",
      agent: "build",
      sessionFile: "C:\\sessions\\task-1.jsonl",
    };
    mocks.getTask.mockReset();
    mocks.readSessionConversation.mockReset();
    mocks.resolveAutoAgent.mockReset();
    mocks.resolveAutoModel.mockReset();
    mocks.goalLoopCommand.mockReset();
    mocks.goalLoopState.mockReset();
    mocks.setTaskAgent.mockReset();
    mocks.setTaskModel.mockReset();
    mocks.setTaskThinkingLevel.mockReset();
    mocks.validateTaskModelSelection.mockReset();
    mocks.getTask.mockImplementation(() => task);
    mocks.readSessionConversation.mockReturnValue([
      { role: "user", text: "調査する" },
      { role: "assistant", text: "問題を確認します" },
    ]);
    mocks.resolveAutoAgent.mockResolvedValue("reviewer");
    mocks.resolveAutoModel.mockResolvedValue({
      providerID: "openai-codex",
      modelID: "gpt-5.6-sol",
      variant: "medium",
      tier: "heavy",
      mode: "balanced",
      reason: "test",
    });
    mocks.setTaskAgent.mockImplementation(async (_id: string, agent: string) => {
      task = { ...task, agent };
      return task;
    });
    mocks.goalLoopCommand.mockResolvedValue({ id: "loop-1", status: "queued" });
    mocks.validateTaskModelSelection.mockResolvedValue(undefined);
  });

  it("resolves Auto before starting Goal Loop and returns the selected agent", async () => {
    const response = await POST(
      request({
        action: "start",
        goal: "テストを追加する",
        acceptance: ["テストが通る"],
        agent: AUTO_AGENT_VALUE,
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAutoAgent).toHaveBeenCalledWith({
      conversation: [
        { role: "user", text: "調査する" },
        { role: "assistant", text: "問題を確認します" },
      ],
      prompt: "テストを追加する",
    });
    expect(mocks.setTaskAgent).toHaveBeenCalledWith("task-1", "reviewer");
    expect(mocks.goalLoopCommand).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        action: "start",
        goal: "テストを追加する",
        autoAgent: true,
      }),
    );
    expect(await response.json()).toEqual({
      loop: { id: "loop-1", status: "queued" },
      agent: "reviewer",
    });
  });

  it("applies the Auto-selected model and effort with the resolved agent", async () => {
    mocks.resolveAutoAgent.mockResolvedValue("build");

    const response = await POST(
      request({
        action: "start",
        goal: "大規模な修正を実施する",
        acceptance: ["テストが通る"],
        agent: AUTO_AGENT_VALUE,
        auto: true,
        model: "openai-codex::gpt-5.6-sol",
        thinkingLevel: "medium",
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.setTaskModel).toHaveBeenCalledWith(
      "task-1",
      "openai-codex::gpt-5.6-sol",
      { accountIdExplicit: false },
    );
    expect(mocks.setTaskThinkingLevel).toHaveBeenCalledWith("task-1", "medium");
  });

  it("applies an explicitly selected agent before starting Goal Loop", async () => {
    const response = await POST(
      request({ action: "start", goal: "レビューする", agent: "reviewer" }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.setTaskAgent).toHaveBeenCalledWith("task-1", "reviewer");
    expect(mocks.goalLoopCommand).toHaveBeenCalled();
  });

  it("validates a requested model before exposing history to Auto agent", async () => {
    mocks.validateTaskModelSelection.mockRejectedValue(
      Object.assign(new Error("モデルが見つかりません"), { status: 400 }),
    );

    const response = await POST(
      request({
        action: "start",
        goal: "秘密の作業",
        agent: AUTO_AGENT_VALUE,
        model: "missing::model",
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.validateTaskModelSelection).toHaveBeenCalledWith("missing::model");
    expect(mocks.readSessionConversation).not.toHaveBeenCalled();
    expect(mocks.resolveAutoAgent).not.toHaveBeenCalled();
    expect(mocks.goalLoopCommand).not.toHaveBeenCalled();
  });

  it("rejects a non-string agent value", async () => {
    const response = await POST(
      request({ action: "start", goal: "作業", agent: null }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.resolveAutoAgent).not.toHaveBeenCalled();
    expect(mocks.goalLoopCommand).not.toHaveBeenCalled();
  });
});
