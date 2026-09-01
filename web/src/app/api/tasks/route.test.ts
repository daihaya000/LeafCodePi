import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  destroyArchivedTasksByProject: vi.fn(),
  getTaskSummariesWithTodoProgress: vi.fn(),
  listModelsForAccounts: vi.fn(),
  listPendingAttention: vi.fn(),
  resolveAutoAgent: vi.fn(),
  parseDirectModelKey: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);
vi.mock("@/lib/auto-agent", () => ({ resolveAutoAgent: mocks.resolveAutoAgent }));
vi.mock("@/lib/direct-generation", () => ({ parseDirectModelKey: mocks.parseDirectModelKey }));

import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import { POST } from "./route";

describe("POST /api/tasks", () => {
  beforeEach(() => {
    mocks.createTask.mockReset();
    mocks.resolveAutoAgent.mockReset();
    mocks.parseDirectModelKey.mockReset();
    mocks.parseDirectModelKey.mockReturnValue(undefined);
    mocks.createTask.mockResolvedValue({ id: "task-1" });
  });

  it("passes null as the project id for a no-project task", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId: null, prompt: "一時作業" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: null, prompt: "一時作業" }),
    );
  });

  it("resolves Auto before creating a task and never persists the sentinel", async () => {
    mocks.resolveAutoAgent.mockResolvedValue("reviewer");

    const response = await POST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId: null, prompt: "差分をレビューして", agent: AUTO_AGENT_VALUE }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAutoAgent).toHaveBeenCalledWith({
      conversation: [],
      prompt: "差分をレビューして",
      hasImages: false,
    });
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "reviewer" }),
    );
    expect(mocks.createTask.mock.calls[0]?.[0].agent).not.toBe(AUTO_AGENT_VALUE);
  });

  it("rejects mismatched model and account before resolving Auto", async () => {
    mocks.parseDirectModelKey.mockReturnValue({
      providerID: "openai-codex",
      modelID: "model-a",
      accountId: "account-a",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          projectId: null,
          prompt: "秘密の作業",
          agent: AUTO_AGENT_VALUE,
          model: "account-a::openai-codex::model-a",
          accountId: "account-b",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.resolveAutoAgent).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("rejects a missing or empty project id instead of silently selecting no-project", async () => {
    for (const body of [{ prompt: "作業" }, { projectId: "", prompt: "作業" }]) {
      mocks.createTask.mockClear();
      const response = await POST(
        new NextRequest("http://localhost/api/tasks", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );

      expect(response.status).toBe(400);
      expect(mocks.createTask).not.toHaveBeenCalled();
    }
  });
});
