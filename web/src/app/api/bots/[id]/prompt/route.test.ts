import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  promptTask: vi.fn(),
  goalLoopCommand: vi.fn(),
  isTaskRuntimeBusyForGoalLoopStart: vi.fn(() => false),
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskPrompt: vi.fn(),
  forwardGoalLoopStart: vi.fn(),
}));
vi.mock("../../../../../lib/pi/harness", () => ({
  promptTask: state.promptTask,
  goalLoopCommand: state.goalLoopCommand,
  isTaskRuntimeBusyForGoalLoopStart: state.isTaskRuntimeBusyForGoalLoopStart,
  jsonError: (error: Error) => ({ error: error.message, status: 500 }),
}));
vi.mock("../../../../../lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: state.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("../../../../../lib/backend-forward", () => ({
  forwardTaskPrompt: state.forwardTaskPrompt,
  forwardGoalLoopStart: state.forwardGoalLoopStart,
  forwardTaskDetail: vi.fn(),
  forwardTaskAbort: vi.fn(),
  forwardPermissionAnswer: vi.fn(),
  forwardQuestionAnswer: vi.fn(),
  needsLocalResolution: vi.fn(() => false),
  forwardablePromptBody: vi.fn((body) => body),
}));

import { createBot, patchBot } from "../../../../../lib/bots";
import { MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGE_TOTAL_BYTES, MAX_PROMPT_TEXT_CHARS } from "../../../../../lib/prompt-images";
import { POST } from "./route";

function request(prompt: unknown, goalLoop?: unknown, images?: unknown): NextRequest {
  return new NextRequest("http://localhost", {
    method: "POST",
    body: JSON.stringify({ prompt, ...(goalLoop === undefined ? {} : { goalLoop }), ...(images === undefined ? {} : { images }) }),
  });
}

describe("POST /api/bots/[id]/prompt", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-api-bot-prompt-"));
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
    state.promptTask.mockResolvedValue({ status: "working" });
    state.goalLoopCommand.mockResolvedValue({ id: "loop-1", status: "queued" });
  });

  afterEach(() => {
    state.promptTask.mockReset();
    state.goalLoopCommand.mockReset();
    state.isTaskRuntimeBusyForGoalLoopStart.mockReset();
    state.isTaskRuntimeBusyForGoalLoopStart.mockReturnValue(false);
    state.localRuntimeBlocked.mockReset();
    state.localRuntimeBlocked.mockReturnValue(false);
    state.forwardTaskPrompt.mockReset();
    state.forwardGoalLoopStart.mockReset();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("forwards an ordinary Bot prompt to the owning Backend", async () => {
    const bot = createBot({ name: "Forwarded bot" });
    state.localRuntimeBlocked.mockReturnValue(true);
    state.forwardTaskPrompt.mockResolvedValue({ ok: true, task: { id: `bot:${bot.id}`, status: "working" } });
    const response = await POST(request("調べて"), { params: Promise.resolve({ id: bot.id }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: `bot:${bot.id}`, status: "working" } });
    expect(state.forwardTaskPrompt).toHaveBeenCalledWith(`bot:${bot.id}`, { prompt: "調べて" });
    expect(state.promptTask).not.toHaveBeenCalled();
  });

    it("replays Backend business errors from the result envelope", async () => {
    const bot = createBot({ name: "Result bot" });
    state.localRuntimeBlocked.mockReturnValue(true);
    state.forwardTaskPrompt.mockResolvedValue({
      ok: true,
      task: null,
      result: { status: 409, body: { error: "a turn is already active" } },
    });
    const response = await POST(request("check"), { params: Promise.resolve({ id: bot.id }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "a turn is already active" });
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it("preserves Backend 4xx refusals for ordinary Bot prompts", async () => {
    const bot = createBot({ name: "Rejected bot" });
    state.localRuntimeBlocked.mockReturnValue(true);
    state.forwardTaskPrompt.mockResolvedValue({ ok: false, reason: "bad-response", status: 409 });
    const response = await POST(request("check"), { params: Promise.resolve({ id: bot.id }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Backendで送信を実行できません", code: "BACKEND_REQUEST_REJECTED" });
    expect(state.promptTask).not.toHaveBeenCalled();
  });

it("forwards a Bot Goal Loop start and never runs it locally", async () => {
    const bot = createBot({ name: "Loop bot 2" });
    const images = [{ mimeType: "image/png", data: "aW1hZ2U=" }];
    state.localRuntimeBlocked.mockReturnValue(true);
    state.forwardGoalLoopStart.mockResolvedValue({ ok: true, loop: { id: "loop-1", status: "queued" }, agent: null });
    const loop = await POST(
      request("調査して修正する", { acceptance: ["テストが通る"], maxTurns: 1000, cooldownSeconds: 999999 }, images),
      { params: Promise.resolve({ id: bot.id }) },
    );
    expect(loop.status).toBe(200);
    await expect(loop.json()).resolves.toEqual({ task: null, loop: { id: "loop-1", status: "queued" } });
    expect(state.forwardGoalLoopStart).toHaveBeenCalledWith(`bot:${bot.id}`, {
      botId: bot.id, goal: "調査して修正する", acceptance: ["テストが通る"],
      maxTurns: 100, cooldownSeconds: 86400, forceFullRun: false, images,
    });
    expect(state.goalLoopCommand).not.toHaveBeenCalled();
    expect(state.isTaskRuntimeBusyForGoalLoopStart).not.toHaveBeenCalled();
    state.forwardTaskPrompt.mockResolvedValue({ ok: false, reason: "unreachable" });
    const failed = await POST(request("調べて"), { params: Promise.resolve({ id: bot.id }) });
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "Backendへ転送できません", code: "BACKEND_FORWARD_FAILED", reason: "unreachable" });
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, reason: "not-configured", expectedStatus: 409 },
    { ok: false, reason: "not-found", status: 404, expectedStatus: 404 },
    { ok: false, reason: "unreachable", expectedStatus: 502 },
    { ok: false, reason: "bad-status", status: 400, expectedStatus: 400 },
    { ok: false, reason: "incompatible", status: 409, expectedStatus: 409 },
    { ok: false, reason: "bad-status", status: 413, expectedStatus: 413 },
    { ok: true, loop: { status: "stopped" }, expectedStatus: 409 },
  ])("does not fall back on Backend refusal: %j", async ({ expectedStatus, ...result }) => {
    const bot = createBot({ name: "Loop bot" });
    state.localRuntimeBlocked.mockReturnValue(true);
    state.forwardGoalLoopStart.mockResolvedValue(result);
    const response = await POST(request("調べる", { acceptance: [] }), { params: Promise.resolve({ id: bot.id }) });
    expect(response.status).toBe(expectedStatus);
    expect(state.goalLoopCommand).not.toHaveBeenCalled();
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it.each([null, [], { acceptance: "invalid" }, { maxTurns: {} }])("rejects invalid options before forwarding: %j", async (goalLoop) => {
    const bot = createBot({ name: "Loop bot" });
    state.localRuntimeBlocked.mockReturnValue(true);
    const response = await POST(request("調べる", goalLoop), { params: Promise.resolve({ id: bot.id }) });
    expect(response.status).toBe(400);
    expect(state.forwardGoalLoopStart).not.toHaveBeenCalled();
    expect(state.goalLoopCommand).not.toHaveBeenCalled();
  });

  it("keeps Goal Loop starts image-only before forwarding", async () => {
    const bot = createBot({ name: "Loop bot" });
    state.localRuntimeBlocked.mockReturnValue(true);
    const response = await POST(new NextRequest("http://localhost", {
      method: "POST",
      body: JSON.stringify({ prompt: "調べる", goalLoop: {}, files: [{ name: "memo.txt", mimeType: "text/plain", data: "aGk=" }] }),
    }), { params: Promise.resolve({ id: bot.id }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Goal loop の開始では画像のみ添付できます" });
    expect(state.forwardGoalLoopStart).not.toHaveBeenCalled();
  });

  it("clamps Goal Loop limits before invoking the command", async () => {
    const bot = createBot({ name: "Loop bot" });

    const response = await POST(
      request("調査して修正する", {
        acceptance: ["テストが通る"],
        maxTurns: 1000,
        cooldownSeconds: 999999,
      }),
      { params: Promise.resolve({ id: bot.id }) },
    );

    expect(response.status).toBe(200);
    expect(state.goalLoopCommand).toHaveBeenCalledWith(`bot:${bot.id}`, expect.objectContaining({ maxTurns: 100, cooldownSeconds: 86400 }));
  });

  it.each([
    null,
    [],
    "invalid",
    { acceptance: "invalid" },
    { forceFullRun: "yes" },
    { acceptance: Array.from({ length: 11 }, (_, index) => `item ${index}`) },
    { acceptance: ["x".repeat(2_001)] },
  ])("rejects malformed Goal Loop options: %j", async (goalLoop) => {
    const bot = createBot({ name: "Loop bot" });

    const response = await POST(request("調査して修正する", goalLoop), { params: Promise.resolve({ id: bot.id }) });

    expect(response.status).toBe(400);
    expect(state.goalLoopCommand).not.toHaveBeenCalled();
  });

  it("rejects more than eight images before prompting", async () => {
    const bot = createBot({ name: "Image bot" });
    const images = Array.from({ length: 9 }, () => ({ mimeType: "image/png", data: "cG5n" }));

    const response = await POST(request("look", undefined, images), { params: Promise.resolve({ id: bot.id }) });

    expect(response.status).toBe(400);
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it("rejects oversized text before prompting", async () => {
    const bot = createBot({ name: "Text bot" });

    const response = await POST(request("x".repeat(MAX_PROMPT_TEXT_CHARS + 1)), { params: Promise.resolve({ id: bot.id }) });

    expect(response.status).toBe(413);
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it.each(["AA ==", "AA="])("rejects Base64 image data with invalid whitespace or padding: %s", async (data) => {
    const bot = createBot({ name: "Image bot" });

    const response = await POST(request("look", undefined, [{ mimeType: "image/png", data }]), { params: Promise.resolve({ id: bot.id }) });

    expect(response.status).toBe(400);
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it("rejects oversized or aggregate images before prompting", async () => {
    const bot = createBot({ name: "Image bot" });
    const images = [{ mimeType: "image/png", data: Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1).toString("base64") }];

    const response = await POST(request("look", undefined, images), { params: Promise.resolve({ id: bot.id }) });

    expect(response.status).toBe(400);
    expect(state.promptTask).not.toHaveBeenCalled();

    const half = Math.floor(MAX_PROMPT_IMAGE_TOTAL_BYTES / 2) + 1;
    const aggregateResponse = await POST(
      request("look", undefined, [
        { mimeType: "image/png", data: Buffer.alloc(half).toString("base64") },
        { mimeType: "image/png", data: Buffer.alloc(half).toString("base64") },
      ]),
      { params: Promise.resolve({ id: bot.id }) },
    );

    expect(aggregateResponse.status).toBe(400);
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it("rejects unsupported image MIME types before prompting", async () => {
    const bot = createBot({ name: "Image bot" });

    const response = await POST(request("look", undefined, [{ mimeType: "application/pdf", data: "cGRm" }]), { params: Promise.resolve({ id: bot.id }) });

    expect(response.status).toBe(400);
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it("keeps direct 1:1 messaging available when the bot is disabled for rooms", async () => {
    const bot = createBot({ name: "Direct bot" });
    patchBot(bot.id, { enabled: false });

    const response = await POST(request("hello"), {
      params: Promise.resolve({ id: bot.id }),
    });

    expect(response.status).toBe(200);
    expect(state.promptTask).toHaveBeenCalledWith(`bot:${bot.id}`, "hello");
  });

  it("starts Goal Loop through the existing command path", async () => {
    const bot = createBot({ name: "Loop bot" });

    const response = await POST(
      request("調査して修正する", {
        acceptance: ["テストが通る"],
        maxTurns: 2,
        cooldownSeconds: 30,
        forceFullRun: true,
      }),
      { params: Promise.resolve({ id: bot.id }) },
    );

    expect(response.status).toBe(200);
    expect(state.goalLoopCommand).toHaveBeenCalledWith(`bot:${bot.id}`, {
      action: "start",
      goal: "調査して修正する",
      acceptance: ["テストが通る"],
      maxTurns: 2,
      cooldownSeconds: 30,
      forceFullRun: true,
    });
    expect(state.promptTask).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      task: null,
      loop: { id: "loop-1", status: "queued" },
    });
  });

  it("passes images to a Goal Loop start", async () => {
    const bot = createBot({ name: "Loop bot" });
    const images = [{ mimeType: "image/png", data: "aW1hZ2U=" }];

    const response = await POST(
      request("画像を確認する", { acceptance: ["確認済み"] }, images),
      { params: Promise.resolve({ id: bot.id }) },
    );

    expect(response.status).toBe(200);
    expect(state.goalLoopCommand).toHaveBeenCalledWith(
      `bot:${bot.id}`,
      expect.objectContaining({ images }),
    );
  });

  it("rejects a non-live Goal Loop start result", async () => {
    const bot = createBot({ name: "Loop bot" });
    state.goalLoopCommand.mockResolvedValue({ id: "loop-1", status: "paused" });

    const response = await POST(
      request("調査して修正する", { acceptance: ["テストが通る"] }),
      { params: Promise.resolve({ id: bot.id }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Goal Loop を開始できませんでした" });
  });
});
