import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, UiMessage } from "@/lib/types";
import { readTaskTranscript, resetTaskTranscriptCache } from "./task-transcript";

const mocks = vi.hoisted(() => ({
  getTaskDetail: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskDetail: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => ({ getTaskDetail: mocks.getTaskDetail }));
vi.mock("@/lib/pi/runtime-ownership", () => ({ localRuntimeBlocked: mocks.localRuntimeBlocked }));
vi.mock("@/lib/backend-forward", () => ({ forwardTaskDetail: mocks.forwardTaskDetail }));

const message = (id: string): UiMessage => ({
  id,
  role: "user",
  createdAt: 1,
  parts: [{ id: `${id}:text`, type: "text", text: id }],
});

describe("readTaskTranscript", () => {
  beforeEach(() => {
    mocks.getTaskDetail.mockReset();
    mocks.localRuntimeBlocked.mockReset().mockReturnValue(false);
    mocks.forwardTaskDetail.mockReset();
    resetTaskTranscriptCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads every time unless a reuse window is given", async () => {
    mocks.getTaskDetail.mockResolvedValue({ messages: [message("a")] } as TaskDetail);
    await readTaskTranscript("task-1");
    await readTaskTranscript("task-1");
    expect(mocks.getTaskDetail).toHaveBeenCalledTimes(2);
  });

  it("shares a read inside the reuse window and reads again after it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    mocks.getTaskDetail.mockResolvedValue({ messages: [message("a")] } as TaskDetail);
    const first = await readTaskTranscript("task-1", { maxAgeMs: 3_000 });
    vi.advanceTimersByTime(2_000);
    const second = await readTaskTranscript("task-1", { maxAgeMs: 3_000 });
    expect(second).toBe(first);
    expect(mocks.getTaskDetail).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_500);
    await readTaskTranscript("task-1", { maxAgeMs: 3_000 });
    expect(mocks.getTaskDetail).toHaveBeenCalledTimes(2);
  });

  it("keeps tasks apart and remembers only the most recent two", async () => {
    mocks.getTaskDetail.mockResolvedValue({ messages: [] } as unknown as TaskDetail);
    for (const id of ["a", "b", "c", "a"]) await readTaskTranscript(id, { maxAgeMs: 60_000 });
    // a was evicted by c, so the second a reads again; b and c share nothing with it.
    expect(mocks.getTaskDetail.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c", "a"]);
    await readTaskTranscript("a", { maxAgeMs: 60_000 });
    expect(mocks.getTaskDetail).toHaveBeenCalledTimes(4);
  });

  it("does not keep failures, rejected or reported", async () => {
    mocks.getTaskDetail.mockRejectedValueOnce(new Error("boom"));
    await expect(readTaskTranscript("task-1", { maxAgeMs: 60_000 })).rejects.toThrow("boom");
    mocks.getTaskDetail.mockResolvedValue({ messages: [message("a")] } as TaskDetail);
    await expect(readTaskTranscript("task-1", { maxAgeMs: 60_000 })).resolves.toMatchObject({ ok: true });
    expect(mocks.getTaskDetail).toHaveBeenCalledTimes(2);

    resetTaskTranscriptCache();
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    await expect(readTaskTranscript("task-2", { maxAgeMs: 60_000 })).resolves.toMatchObject({ ok: false });
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: true, detail: { messages: [message("a")] } });
    await expect(readTaskTranscript("task-2", { maxAgeMs: 60_000 })).resolves.toMatchObject({ ok: true });
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
  });

  it("reads the transcript on disk without waiting for a live session", async () => {
    mocks.getTaskDetail.mockResolvedValue({ messages: [message("a")] } as TaskDetail);
    await expect(readTaskTranscript("task-1")).resolves.toEqual({ ok: true, messages: [message("a")] });
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("task-1", { offline: true });
    expect(mocks.forwardTaskDetail).not.toHaveBeenCalled();
  });

  it("reads the full Backend detail once the Backend owns the session", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { messages: [message("a"), message("b")] } });
    const result = await readTaskTranscript("task-1");
    expect(result).toEqual({ ok: true, messages: [message("a"), message("b")] });
    expect(mocks.forwardTaskDetail).toHaveBeenCalledWith("task-1");
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("treats a Backend detail without messages as an empty transcript", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: null });
    await expect(readTaskTranscript("task-1")).resolves.toEqual({ ok: true, messages: [] });
  });

  it("maps Backend failures to the statuses of the history page route", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: false, reason: "not-found", status: 404 });
    await expect(readTaskTranscript("task-1")).resolves.toMatchObject({ ok: false, status: 404 });
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: false, reason: "not-configured" });
    await expect(readTaskTranscript("task-1")).resolves.toMatchObject({
      ok: false,
      status: 409,
      body: { code: "RUNTIME_NOT_OWNED" },
    });
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    await expect(readTaskTranscript("task-1")).resolves.toMatchObject({
      ok: false,
      status: 502,
      body: { code: "BACKEND_FORWARD_FAILED", reason: "unreachable" },
    });
  });
});
