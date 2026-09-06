import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  readSessionConversation: vi.fn(),
  resolveAutoAgent: vi.fn(),
  autoAgentHasOwnModel: vi.fn(),
  resolveAutoModel: vi.fn(),
  promptTask: vi.fn(),
  validateTaskModelSelection: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status:
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : 500,
  })),
  isRecoverableResumeSelectionError: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/direct-session", () => ({
  readSessionConversation: mocks.readSessionConversation,
}));
vi.mock("@/lib/auto-agent", () => ({
  resolveAutoAgent: mocks.resolveAutoAgent,
  autoAgentHasOwnModel: mocks.autoAgentHasOwnModel,
}));
vi.mock("@/lib/pi/harness", () => ({
  isRecoverableResumeSelectionError: mocks.isRecoverableResumeSelectionError,
  jsonError: mocks.jsonError,
  promptTask: mocks.promptTask,
  resolveAutoModel: mocks.resolveAutoModel,
  validateTaskModelSelection: mocks.validateTaskModelSelection,
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
    mocks.autoAgentHasOwnModel.mockReset();
    mocks.autoAgentHasOwnModel.mockReturnValue(false);
    mocks.resolveAutoModel.mockReset();
    mocks.promptTask.mockReset();
    mocks.validateTaskModelSelection.mockReset();
    mocks.isRecoverableResumeSelectionError.mockReset();
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
    mocks.resolveAutoModel.mockResolvedValue({
      providerID: "openai-codex",
      modelID: "gpt-5.6-sol",
      variant: "medium",
      tier: "heavy",
      mode: "balanced",
      reason: "test",
    });
    mocks.promptTask.mockResolvedValue({ id: "task-1", agent: "reviewer" });
    mocks.validateTaskModelSelection.mockResolvedValue(undefined);
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
        accountIdExplicit: false,
      }),
    );
  });

  it("selects the Auto agent while Auto model routing is still running", async () => {
    let releaseModel: (decision: unknown) => void = () => {};
    mocks.autoAgentHasOwnModel.mockReturnValue(true);
    mocks.resolveAutoModel.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseModel = resolve;
        }),
    );
    mocks.resolveAutoAgent.mockResolvedValue("build");

    const pending = POST(
      request({ prompt: "実装して", agent: AUTO_AGENT_VALUE, auto: true }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    await vi.waitFor(() => expect(mocks.resolveAutoAgent).toHaveBeenCalled());
    // Selection started without the Auto route, so it did not wait for the model.
    expect(mocks.resolveAutoAgent.mock.calls[0]?.[0]).not.toHaveProperty("requestedModel");
    releaseModel({
      providerID: "openai-codex",
      modelID: "gpt-5.6-sol",
      variant: "medium",
      tier: "light",
      mode: "cost",
      reason: "test",
    });

    expect((await pending).status).toBe(200);
    expect(mocks.resolveAutoAgent).toHaveBeenCalledTimes(1);
    expect(mocks.promptTask).toHaveBeenCalledWith(
      "task-1",
      "実装して",
      undefined,
      expect.objectContaining({ agent: "build", model: "openai-codex::gpt-5.6-sol" }),
    );
  });

  it("keeps an explicit Auto retry route without resolving Auto again", async () => {
    const response = await POST(
      request({
        prompt: "再試行",
        auto: true,
        autoRetry: true,
        model: "anthropic::claude-sonnet-5",
        thinkingLevel: "high",
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAutoModel).not.toHaveBeenCalled();
    expect(mocks.promptTask).toHaveBeenCalledWith(
      "task-1",
      "再試行",
      undefined,
      expect.objectContaining({
        model: "anthropic::claude-sonnet-5",
        thinkingLevel: "high",
        accountIdExplicit: false,
      }),
    );
  });

  it("passes stale resume model metadata through for server-side recovery", async () => {
    mocks.validateTaskModelSelection.mockRejectedValue(
      Object.assign(new Error("モデルが見つかりません"), { status: 400 }),
    );
    mocks.isRecoverableResumeSelectionError.mockReturnValue(true);

    const response = await POST(
      request({
        prompt: "中断したターンを再開",
        model: "deleted-account::anthropic::removed-model",
        resume: true,
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.validateTaskModelSelection).toHaveBeenCalledWith(
      "deleted-account::anthropic::removed-model",
    );
    expect(mocks.promptTask).toHaveBeenCalledWith(
      "task-1",
      "中断したターンを再開",
      undefined,
      expect.objectContaining({
        model: "deleted-account::anthropic::removed-model",
        resume: true,
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
      request({
        prompt: "続けて",
        agent: AUTO_AGENT_VALUE,
        auto: true,
        model: "anthropic::stale-model",
        thinkingLevel: "high",
        streamingBehavior: "steer",
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAutoAgent).not.toHaveBeenCalled();
    expect(mocks.promptTask).toHaveBeenCalledWith(
      "task-1",
      "続けて",
      undefined,
      expect.objectContaining({
        agent: "build",
        model: undefined,
        thinkingLevel: undefined,
        streamingBehavior: "steer",
      }),
    );
  });

  it("validates a requested model before exposing history to Auto agent", async () => {
    mocks.validateTaskModelSelection.mockRejectedValue(
      Object.assign(new Error("モデルが見つかりません"), { status: 400 }),
    );

    const response = await POST(
      request({
        prompt: "秘密の作業",
        agent: AUTO_AGENT_VALUE,
        model: "missing::model",
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.validateTaskModelSelection).toHaveBeenCalledWith("missing::model");
    expect(mocks.readSessionConversation).not.toHaveBeenCalled();
    expect(mocks.resolveAutoAgent).not.toHaveBeenCalled();
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });

  it("rejects a non-string agent value", async () => {
    const response = await POST(
      request({ prompt: "作業", agent: null }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });

  it("rejects malformed image attachments before prompting", async () => {
    const response = await POST(
      request({ prompt: "作業", images: [{ mimeType: "image/png" }] }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });

  it("rejects an invalid permission mode before prompting", async () => {
    const response = await POST(
      request({ prompt: "作業", permissionMode: "invalid" }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });
});
