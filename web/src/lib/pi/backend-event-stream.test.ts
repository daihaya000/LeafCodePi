import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBackendTaskStream } from "./backend-event-stream";

const mocks = vi.hoisted(() => ({
  forwardTaskDetail: vi.fn(),
  forwardTaskPendingRequests: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => mocks);

const pending = { permissionRequest: null, questionRequest: null };
const detail = (revision: number) => ({ id: "task-1", updatedAt: revision, messages: [] });
const result = (revision: number) => ({ ok: true as const, detail: detail(revision) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const sink = () => ({ closed: false, send: vi.fn() });

async function start(sse: ReturnType<typeof sink>) {
  const stream = await startBackendTaskStream({ id: "task-1", sse });
  if (!stream.ok) throw new Error(stream.reason);
  return stream;
}

describe("Backend task stream polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.forwardTaskDetail.mockReset().mockResolvedValue(result(0));
    mocks.forwardTaskPendingRequests.mockReset().mockResolvedValue(pending);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("serializes slow detail reads so later snapshots cannot overtake them", async () => {
    const sse = sink();
    const stream = await start(sse);
    const slow = deferred<ReturnType<typeof result>>();
    mocks.forwardTaskDetail.mockReturnValueOnce(slow.promise).mockResolvedValue(result(2));
    try {
      await vi.advanceTimersByTimeAsync(6_000);
      expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
      expect(sse.send).toHaveBeenCalledTimes(1);
      slow.resolve(result(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ task: { id: "task-1", updatedAt: 1 } }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
      expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ task: { id: "task-1", updatedAt: 2 } }));
    } finally {
      stream.stop();
    }
  });

  it("keeps the poll busy until the pending request read finishes", async () => {
    const sse = sink();
    const stream = await start(sse);
    const slow = deferred<typeof pending>();
    mocks.forwardTaskPendingRequests.mockReturnValueOnce(slow.promise);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    expect(sse.send).toHaveBeenCalledTimes(1);
    slow.resolve(pending);
    await vi.advanceTimersByTimeAsync(0);
    expect(sse.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    stream.stop();
  });

  it.each(["detail", "pending"] as const)("does not send a delayed %s result after stop", async (phase) => {
    const sse = sink();
    const stream = await start(sse);
    const slowDetail = deferred<ReturnType<typeof result>>();
    const slowPending = deferred<typeof pending>();
    if (phase === "detail") mocks.forwardTaskDetail.mockReturnValueOnce(slowDetail.promise);
    else mocks.forwardTaskPendingRequests.mockReturnValueOnce(slowPending.promise);
    await vi.advanceTimersByTimeAsync(2_000);
    stream.stop();
    stream.stop();
    slowDetail.resolve(result(1));
    slowPending.resolve(pending);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sse.send).toHaveBeenCalledTimes(1);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(phase === "detail" ? 1 : 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["detail", "pending"] as const)("releases the poll after a rejected %s read and retries", async (phase) => {
    const sse = sink();
    const stream = await start(sse);
    const read = phase === "detail" ? mocks.forwardTaskDetail : mocks.forwardTaskPendingRequests;
    read.mockRejectedValueOnce(new Error("transport failure"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    expect(sse.send).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("releases the poll after a failed detail response and retries", async () => {
    const sse = sink();
    const stream = await start(sse);
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenCalledTimes(1);
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    expect(sse.send).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("preserves the initial failure contract without starting a timer", async () => {
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    const sse = sink();
    expect(await startBackendTaskStream({ id: "task-1", sse })).toEqual({ ok: false, reason: "unreachable" });
    expect(sse.send).not.toHaveBeenCalled();
    expect(mocks.forwardTaskPendingRequests).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
