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
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: vi.fn(() => false),
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({
  forwardTaskPrompt: vi.fn(),
  needsLocalResolution: vi.fn(() => false),
  forwardablePromptBody: vi.fn((body) => body),
}));
vi.mock("@/lib/pi/harness", () => ({
  isRecoverableResumeSelectionError: mocks.isRecoverableResumeSelectionError,
  jsonError: mocks.jsonError,
  promptTask: mocks.promptTask,
  resolveAutoModel: mocks.resolveAutoModel,
  validateTaskModelSelection: mocks.validateTaskModelSelection,
}));

import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardTaskPrompt, needsLocalResolution } from "@/lib/backend-forward";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import { MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_TEXT_CHARS } from "@/lib/prompt-images";
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
      agent: "builder",
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
    // Ownership and forwarding are per-test: a leftover value would make every later test forward.
    vi.mocked(localRuntimeBlocked).mockReturnValue(false);
    vi.mocked(needsLocalResolution).mockReturnValue(false);
    vi.mocked(forwardTaskPrompt).mockReset();
  });

  it("forwards the prompt to the owning Backend instead of starting a session", async () => {
    vi.mocked(localRuntimeBlocked).mockReturnValue(true);
    vi.mocked(needsLocalResolution).mockReturnValue(false);
    vi.mocked(forwardTaskPrompt).mockResolvedValue({ ok: true, task: { id: "task-1", status: "working" } });
    const response = await POST(request({ prompt: "こんにちは" }), { params: Promise.resolve({ id: "task-1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "task-1", status: "working" } });
    // Nothing local ran: no task read, no in-process session.
    expect(mocks.getTask).not.toHaveBeenCalled();
    expect(mocks.promptTask).not.toHaveBeenCalled();
    expect(vi.mocked(forwardTaskPrompt).mock.calls[0][0]).toBe("task-1");
  });

  it("preserves domain rejection statuses rather than turning them into transport errors", async () => {
    vi.mocked(localRuntimeBlocked).mockReturnValue(true);
    for (const status of [400, 404, 409, 413, 422, 429]) {
      vi.mocked(forwardTaskPrompt).mockResolvedValue({ ok: false, reason: "bad-response", status });
      const response = await POST(request({ prompt: "test" }), { params: Promise.resolve({ id: "task-1" }) });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code: "BACKEND_REQUEST_REJECTED" });
    }
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });

  it("never falls back locally when the Backend cannot take the prompt", async () => {
    vi.mocked(localRuntimeBlocked).mockReturnValue(true);
    vi.mocked(needsLocalResolution).mockReturnValue(false);
    vi.mocked(forwardTaskPrompt).mockResolvedValue({ ok: false, reason: "unreachable" });
    const failed = await POST(request({ prompt: "こんにちは" }), { params: Promise.resolve({ id: "task-1" }) });
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "Backendへ転送できません", code: "BACKEND_FORWARD_FAILED", reason: "unreachable" });
    vi.mocked(forwardTaskPrompt).mockResolvedValue({ ok: false, reason: "not-configured" });
    const unconfigured = await POST(request({ prompt: "こんにちは" }), { params: Promise.resolve({ id: "task-1" }) });
    expect(unconfigured.status).toBe(409);
    await expect(unconfigured.json()).resolves.toEqual({ error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" });
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });

  it("forwards Auto to the owner instead of refusing it or resolving locally", async () => {
    vi.mocked(localRuntimeBlocked).mockReturnValue(true);
    const body = { task: { id: "task-1" }, autoDecision: { modelID: "selected" } };
    vi.mocked(forwardTaskPrompt).mockResolvedValue({ ok: true, task: body.task, result: { status: 200, body } });
    const response = await POST(request({ prompt: "こんにちは", auto: true }), { params: Promise.resolve({ id: "task-1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(body);
    expect(forwardTaskPrompt).toHaveBeenCalledWith("task-1", expect.objectContaining({ auto: true }));
    expect(mocks.resolveAutoModel).not.toHaveBeenCalled();
    expect(mocks.resolveAutoAgent).not.toHaveBeenCalled();
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });

  it("replays the owner's original business error and status", async () => {
    vi.mocked(localRuntimeBlocked).mockReturnValue(true);
    vi.mocked(forwardTaskPrompt).mockResolvedValue({ ok: true, task: null, result: { status: 409, body: { error: "停止後に再試行してください" } } });
    const response = await POST(request({ prompt: "test" }), { params: Promise.resolve({ id: "task-1" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "停止後に再試行してください" });
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
    mocks.resolveAutoAgent.mockResolvedValue("builder");

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
        agent: "builder",
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
    mocks.resolveAutoAgent.mockResolvedValue("builder");

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
      expect.objectContaining({ agent: "builder", model: "openai-codex::gpt-5.6-sol" }),
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
      agent: "builder",
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
        agent: "builder",
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

  it("forwards impact-aware steering to the owning prompt handler", async () => {
    mocks.getTask.mockReturnValue({ id: "task-1", status: "working", agent: "builder" });
    const response = await POST(request({ prompt: "new direction", streamingBehavior: "steer", interruptIfSafe: true }),
      { params: Promise.resolve({ id: "task-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.promptTask).toHaveBeenCalledWith("task-1", "new direction", undefined,
      expect.objectContaining({ streamingBehavior: "steer", interruptIfSafe: true }));
  });

  it.each([
    { interruptIfSafe: "true", streamingBehavior: "steer" },
    { interruptIfSafe: true },
    { interruptIfSafe: true, streamingBehavior: "followUp" },
  ])("rejects invalid interruption options: %j", async (options) => {
    const response = await POST(request({ prompt: "fix", ...options }), { params: Promise.resolve({ id: "task-1" }) });
    expect(response.status).toBe(400);
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

  it("rejects a non-string prompt without throwing", async () => {
    const response = await POST(
      request({ prompt: { trim: "作業" } }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });

  it("rejects oversized text before prompting", async () => {
    const response = await POST(
      request({ prompt: "x".repeat(MAX_PROMPT_TEXT_CHARS + 1) }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(413);
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

  it("rejects oversized image attachments before prompting", async () => {
    const response = await POST(
      request({ prompt: "作業", images: [{ mimeType: "image/png", data: Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1).toString("base64") }] }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });

  it("ignores Composer permission fields because Settings decide them", async () => {
    const response = await POST(
      request({
        prompt: "作業",
        permissionMode: "invalid",
        skillPermission: "deny",
        subagentPermission: "allow",
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    const options = mocks.promptTask.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(options).not.toHaveProperty("permissionMode");
    expect(options).not.toHaveProperty("skillPermission");
    expect(options).not.toHaveProperty("subagentPermission");
  });
});
