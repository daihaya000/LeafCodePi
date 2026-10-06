import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, UiMessage } from "@/lib/types";
import { resetTaskTranscriptCache } from "@/lib/task-transcript";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  getTaskDetail: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskDetail: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => ({ getTaskDetail: mocks.getTaskDetail, jsonError: mocks.jsonError }));
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

function message(id: string, role: "user" | "assistant", text: string, extra: Partial<UiMessage> = {}): UiMessage {
  return { id, role, createdAt: 1, parts: [{ id: `${id}:text`, type: "text", text }], ...extra };
}

const context = { params: Promise.resolve({ id: "task-1" }) };
const request = (query: string) => new NextRequest(`http://127.0.0.1:3010/api/tasks/task-1/search${query}`);

describe("/api/tasks/[id]/search", () => {
  beforeEach(() => {
    mocks.getTaskDetail.mockReset();
    mocks.localRuntimeBlocked.mockReset().mockReturnValue(false);
    mocks.forwardTaskDetail.mockReset();
    resetTaskTranscriptCache();
  });

  it("shares one transcript read between searches refined within a few seconds", async () => {
    mocks.getTaskDetail.mockResolvedValue({ messages: [message("u1", "user", "needle haystack")] } as TaskDetail);
    const [first, second] = await Promise.all([GET(request("?q=need"), context), GET(request("?q=needle"), context)]);
    expect((await first.json()).total).toBe(1);
    expect((await second.json()).total).toBe(1);
    await GET(request("?q=hay"), context);
    expect(mocks.getTaskDetail).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed read", async () => {
    mocks.getTaskDetail.mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 503 }));
    expect((await GET(request("?q=needle"), context)).status).toBe(503);
    mocks.getTaskDetail.mockResolvedValue({ messages: [message("u1", "user", "needle")] } as TaskDetail);
    expect((await (await GET(request("?q=needle"), context)).json()).total).toBe(1);
    expect(mocks.getTaskDetail).toHaveBeenCalledTimes(2);
  });

  it("searches the whole transcript read offline and returns hits with snippets", async () => {
    mocks.getTaskDetail.mockResolvedValue({
      messages: [
        message("u1", "user", "ログイン画面のエラーを直して"),
        message("a1", "assistant", "原因を調べます"),
        message("a2", "assistant", "エラーの原因は tokenの期限切れ です"),
      ],
    } as TaskDetail);

    const response = await GET(request("?q=%E3%82%A8%E3%83%A9%E3%83%BC"), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ total: 2, truncated: false, terms: ["エラー"] });
    expect(body.hits.map((hit: { messageId: string }) => hit.messageId)).toEqual(["u1", "a2"]);
    expect(body.hits[1]).toMatchObject({ role: "assistant", count: 1 });
    expect(body.hits[1].snippet.slice(body.hits[1].highlights[0][0], body.hits[1].highlights[0][1])).toBe("エラー");
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("task-1", { offline: true });
  });

  it("skips hang-retry prompts, which the timeline never shows", async () => {
    mocks.getTaskDetail.mockResolvedValue({
      messages: [message("r1", "user", "needle retry", { hangRetry: true }), message("u1", "user", "needle")],
    } as TaskDetail);
    const body = await (await GET(request("?q=needle"), context)).json();
    expect(body.hits.map((hit: { messageId: string }) => hit.messageId)).toEqual(["u1"]);
  });

  it("limits the hits to the newest ones and reports the total", async () => {
    mocks.getTaskDetail.mockResolvedValue({
      messages: Array.from({ length: 6 }, (_, index) => message(`m${index}`, "user", `needle ${index}`)),
    } as TaskDetail);
    const body = await (await GET(request("?q=needle&limit=2"), context)).json();
    expect(body).toMatchObject({ total: 6, truncated: true });
    expect(body.hits.map((hit: { messageId: string }) => hit.messageId)).toEqual(["m4", "m5"]);
  });

  it("rejects an empty or oversized query without reading the transcript", async () => {
    expect((await GET(request(""), context)).status).toBe(400);
    expect((await GET(request("?q=%20%20"), context)).status).toBe(400);
    expect((await GET(request(`?q=${"a".repeat(401)}`), context)).status).toBe(400);
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("reads the whole detail from the Backend once it owns the session", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValue({
      ok: true,
      detail: { messages: [message("u1", "user", "needle here")] },
    });
    const body = await (await GET(request("?q=needle"), context)).json();
    expect(body.hits).toHaveLength(1);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledWith("task-1");
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("maps Backend failures the way the history page route does", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: false, reason: "not-found", status: 404 });
    expect((await GET(request("?q=x"), context)).status).toBe(404);
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: false, reason: "not-configured" });
    const unowned = await GET(request("?q=x"), context);
    expect(unowned.status).toBe(409);
    expect(await unowned.json()).toMatchObject({ code: "RUNTIME_NOT_OWNED" });
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    const failed = await GET(request("?q=x"), context);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "BACKEND_FORWARD_FAILED", reason: "unreachable" });
  });

  it("reports a missing task with the harness status", async () => {
    mocks.getTaskDetail.mockRejectedValue(Object.assign(new Error("タスクが見つかりません"), { status: 404 }));
    const response = await GET(request("?q=x"), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "タスクが見つかりません" });
  });
});
