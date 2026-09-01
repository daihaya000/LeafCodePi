import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  readSessionConversation: vi.fn(),
  resolveAutoAgent: vi.fn(),
  goalLoopCommand: vi.fn(),
  goalLoopState: vi.fn(),
  setTaskAgent: vi.fn(),
  setTaskModel: vi.fn(),
  setTaskThinkingLevel: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  loadAgentDefinition: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/direct-session", () => ({
  readSessionConversation: mocks.readSessionConversation,
}));
vi.mock("@/lib/auto-agent", () => ({ resolveAutoAgent: mocks.resolveAutoAgent }));
vi.mock("@/lib/agents", () => ({ loadAgentDefinition: mocks.loadAgentDefinition }));
vi.mock("@/lib/pi/harness", () => ({
  goalLoopCommand: mocks.goalLoopCommand,
  goalLoopState: mocks.goalLoopState,
  jsonError: mocks.jsonError,
  setTaskAgent: mocks.setTaskAgent,
  setTaskModel: mocks.setTaskModel,
  setTaskThinkingLevel: mocks.setTaskThinkingLevel,
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
    mocks.goalLoopCommand.mockReset();
    mocks.goalLoopState.mockReset();
    mocks.setTaskAgent.mockReset();
    mocks.setTaskModel.mockReset();
    mocks.setTaskThinkingLevel.mockReset();
    mocks.loadAgentDefinition.mockReset();
    mocks.getTask.mockImplementation(() => task);
    mocks.readSessionConversation.mockReturnValue([
      { role: "user", text: "調査する" },
      { role: "assistant", text: "問題を確認します" },
    ]);
    mocks.resolveAutoAgent.mockResolvedValue("reviewer");
    mocks.setTaskAgent.mockImplementation(async (_id: string, agent: string) => {
      task = { ...task, agent };
      return task;
    });
    mocks.goalLoopCommand.mockResolvedValue({ id: "loop-1", status: "queued" });
    mocks.loadAgentDefinition.mockReturnValue(undefined);
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
      expect.objectContaining({ action: "start", goal: "テストを追加する" }),
    );
    expect(await response.json()).toEqual({
      loop: { id: "loop-1", status: "queued" },
      agent: "reviewer",
    });
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
