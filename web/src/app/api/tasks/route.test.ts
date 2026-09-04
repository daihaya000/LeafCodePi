import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  destroyArchivedTasksByProject: vi.fn(),
  getTaskSummariesWithTodoProgress: vi.fn(),
  listPendingAttention: vi.fn(),
  resolveAutoAgent: vi.fn(),
  resolveAutoModel: vi.fn(),
  parseDirectModelKey: vi.fn(),
  validateTaskModelSelection: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status:
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : 500,
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
    mocks.resolveAutoModel.mockReset();
    mocks.parseDirectModelKey.mockReset();
    mocks.validateTaskModelSelection.mockReset();
    mocks.parseDirectModelKey.mockReturnValue(undefined);
    mocks.validateTaskModelSelection.mockResolvedValue(undefined);
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

  it("keeps an explicit Auto route authoritative when resolving Auto agent", async () => {
    mocks.resolveAutoAgent.mockResolvedValue("build");
    mocks.resolveAutoModel.mockResolvedValue({
      providerID: "openai-codex",
      modelID: "gpt-5.6-sol",
      variant: "medium",
      tier: "light",
      mode: "balanced",
      reason: "test",
    });
    const response = await POST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          projectId: null,
          prompt: "なぜこうなるの",
          agent: AUTO_AGENT_VALUE,
          auto: true,
          autoOptimize: "balanced",
          autoRouteOverrides: {
            version: 2,
            modes: {
              balanced: {
                light: {
                  candidates: [
                    {
                      kind: "model",
                      providerID: "openai-codex",
                      modelID: "gpt-5.6-sol",
                      variant: "medium",
                    },
                  ],
                },
              },
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAutoAgent).toHaveBeenCalledWith({
      conversation: [],
      prompt: "なぜこうなるの",
      hasImages: false,
      requestedModel: {
        providerID: "openai-codex",
        modelID: "gpt-5.6-sol",
      },
    });
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "build",
        model: "openai-codex::gpt-5.6-sol",
        thinkingLevel: "medium",
      }),
    );
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

  it("validates a requested model before resolving Auto agent", async () => {
    mocks.validateTaskModelSelection.mockRejectedValue(
      Object.assign(new Error("モデルが見つかりません"), { status: 400 }),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          projectId: null,
          prompt: "秘密の作業",
          agent: AUTO_AGENT_VALUE,
          model: "missing::model",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.validateTaskModelSelection).toHaveBeenCalledWith(
      "missing::model",
      null,
      { accountIdExplicit: false },
    );
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

  it("creates a task from images when the prompt is empty", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          projectId: null,
          prompt: "",
          images: [{ mimeType: "image/png", data: "abc" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        prompt: "",
        images: [{ mimeType: "image/png", data: "abc" }],
      }),
    );
  });

  it("rejects an empty prompt when there are no images", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId: null, prompt: "   " }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("rejects an invalid permission mode before creating a task", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId: null, prompt: "作業", permissionMode: "invalid" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });
});
