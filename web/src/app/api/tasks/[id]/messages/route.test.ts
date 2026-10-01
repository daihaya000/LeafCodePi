import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, UiMessage } from "@/lib/types";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  getTaskDetail: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskDetail: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({
  forwardTaskDetail: mocks.forwardTaskDetail,
  forwardTaskPrompt: vi.fn(),
  needsLocalResolution: vi.fn(() => false),
  forwardablePromptBody: vi.fn((body) => body),
}));

function message(id: string, createdAt = 1): UiMessage {
  return {
    id,
    role: "user",
    createdAt,
    parts: [{ id: `${id}:text`, type: "text", text: id }],
  };
}

describe("/api/tasks/[id]/messages", () => {
  beforeEach(() => {
    mocks.getTaskDetail.mockReset();
    mocks.jsonError.mockClear();
    mocks.localRuntimeBlocked.mockReset();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.forwardTaskDetail.mockReset();
  });

  it("returns the page before the cursor", async () => {
    const messages = Array.from({ length: 52 }, (_, index) => message(`m${index + 1}`, index));
    mocks.getTaskDetail.mockResolvedValue({ messages } as TaskDetail);

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/messages?before=m52"),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      messages: messages.slice(1, 51),
      messageHistory: { hasMore: true, nextCursor: "m2" },
    });
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("task-1", { offline: true });
  });

  it("rejects an empty or unknown cursor", async () => {
    const empty = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/messages?before=%20"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    expect(empty.status).toBe(400);
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();

    mocks.getTaskDetail.mockResolvedValue({ messages: [message("m1")] } as TaskDetail);
    const unknown = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/messages?before=missing"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({ error: "履歴カーソルが無効です" });
  });
});

describe("/api/tasks/[id]/messages after the cutover", () => {
  beforeEach(() => {
    mocks.localRuntimeBlocked.mockReset();
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockReset();
    mocks.getTaskDetail.mockReset();
  });

  it("requests an older page from the Backend and preserves its cursor", async () => {
    const messages = [message("m100"), message("m101")];
    const messageHistory = { hasMore: true, nextCursor: "m100" };
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { messages, messageHistory } });
    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/messages?before=m150"), {
      params: Promise.resolve({ id: "task-1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages, messageHistory });
    expect(mocks.forwardTaskDetail).toHaveBeenCalledWith("task-1", { messages: "page", before: "m150" });
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("returns a cursor conflict as 409 but keeps protocol failures as 502", async () => {
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "invalid-cursor", status: 409 });
    const url = "http://localhost/api/tasks/task-1/messages?before=missing";
    const response = await GET(new NextRequest(url), { params: Promise.resolve({ id: "task-1" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "履歴カーソルが無効です" });
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "incompatible", status: 409 });
    const mismatch = await GET(new NextRequest(url), { params: Promise.resolve({ id: "task-1" }) });
    expect(mismatch.status).toBe(502);
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("pages the Backend history with the same rule and never reads locally", async () => {
    const messages = Array.from({ length: 52 }, (_, index) => message(`m${index + 1}`, index));
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { messages } });
    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/messages"), {
      params: Promise.resolve({ id: "task-1" }),
    });
    expect(response.status).toBe(200);
    expect(Array.isArray((await response.json()).messages)).toBe(true);
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("keeps rejecting a bad cursor, and reports a Backend failure without falling back", async () => {
    const badCursor = await GET(new NextRequest("http://localhost/api/tasks/task-1/messages?before=%20"), {
      params: Promise.resolve({ id: "task-1" }),
    });
    expect(badCursor.status).toBe(400);
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "unreachable" });
    const failed = await GET(new NextRequest("http://localhost/api/tasks/task-1/messages"), {
      params: Promise.resolve({ id: "task-1" }),
    });
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "Backendから取得できません", code: "BACKEND_FORWARD_FAILED", reason: "unreachable" });
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "not-configured" });
    const unconfigured = await GET(new NextRequest("http://localhost/api/tasks/task-1/messages"), {
      params: Promise.resolve({ id: "task-1" }),
    });
    expect(unconfigured.status).toBe(409);
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    const missing = await GET(new NextRequest("http://localhost/api/tasks/task-1/messages"), {
      params: Promise.resolve({ id: "task-1" }),
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "タスクが見つかりません" });
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("treats a Backend detail without messages as an empty history", async () => {
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { id: "task-1" } });
    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/messages"), {
      params: Promise.resolve({ id: "task-1" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ messages: [] });
  });
});
