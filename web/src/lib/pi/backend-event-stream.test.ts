import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendTaskSnapshot, startBackendTaskStream } from "./backend-event-stream";
import { createSseWriter } from "@/lib/sse-writer";

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

  it("asks the Backend for a page on initial reads and polls", async () => {
    const stream = await start(sink());
    await vi.advanceTimersByTimeAsync(2_000);
    stream.stop();
    expect(mocks.forwardTaskDetail.mock.calls).toEqual([
      ["task-1", { messages: "page" }], ["task-1", { messages: "page" }],
    ]);
  });

  it("preserves the owner's page cursor instead of paging the page again", () => {
    const messages = Array.from({ length: 50 }, (_, index) => ({ id: `m${index + 4950}`, role: "user", parts: [] }));
    const messageHistory = { hasMore: true, nextCursor: "m4950" };
    const snapshot = backendTaskSnapshot({ id: "task-1", messages, messageHistory }, pending);
    expect(snapshot.messages).toEqual(messages);
    expect(snapshot.messageHistory).toEqual(messageHistory);
    expect(snapshot.task).toEqual({ id: "task-1" });
  });

  it("still pages full history from an older Backend that ignores the query", () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({ id: `m${index}`, role: "user", parts: [] }));
    const snapshot = backendTaskSnapshot({ id: "task-1", messages }, pending);
    expect(snapshot.messages).toEqual(messages.slice(-50));
    expect(snapshot.messageHistory).toEqual({ hasMore: true, nextCursor: "m50" });
    expect(messages).toHaveLength(100);
  });

  it("serializes each snapshot only once with the real SSE writer", async () => {
    const enqueue = vi.fn();
    const controller = { enqueue } as unknown as ReadableStreamDefaultController<Uint8Array>;
    const sse = createSseWriter(controller);
    const toJSON = vi.fn(() => ({ unreadCount: 1 }));
    const stream = await startBackendTaskStream({ id: "task-1", sse, extra: { intercomInbox: { toJSON } } });
    if (!stream.ok) throw new Error(stream.reason);
    try {
      expect(toJSON).toHaveBeenCalledTimes(1);
      const frame = new TextDecoder().decode(enqueue.mock.calls[0][0]);
      expect(frame).toContain('"intercomInbox":{"unreadCount":1}');
      mocks.forwardTaskDetail.mockResolvedValue(result(1));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(toJSON).toHaveBeenCalledTimes(2);
      expect(enqueue).toHaveBeenCalledTimes(2);
    } finally {
      stream.stop();
      sse.cleanup();
    }
  });

  it("reads detail and pending concurrently instead of adding their latencies", async () => {
    const slow = deferred<ReturnType<typeof result>>();
    mocks.forwardTaskDetail.mockReturnValueOnce(slow.promise);
    const sse = sink();
    const starting = start(sse);
    await vi.advanceTimersByTimeAsync(0);
    const pendingCallsWhileDetailBlocked = mocks.forwardTaskPendingRequests.mock.calls.length;
    slow.resolve(result(0));
    const stream = await starting;
    stream.stop();
    expect(pendingCallsWhileDetailBlocked).toBe(1);
  });

  it("shares overlapping reads across viewers but keeps their extra fields separate", async () => {
    const slow = deferred<ReturnType<typeof result>>();
    mocks.forwardTaskDetail.mockReturnValue(slow.promise);
    const first = sink();
    const second = sink();
    const starting = [
      startBackendTaskStream({ id: "task-1", sse: first, extra: { viewer: 1 } }),
      startBackendTaskStream({ id: "task-1", sse: second, extra: { viewer: 2 } }),
    ];
    await vi.advanceTimersByTimeAsync(0);
    slow.resolve(result(0));
    const streams = await Promise.all(starting);
    for (const stream of streams) if (stream.ok) stream.stop();
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(1);
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(1);
    expect(first.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ viewer: 1 }));
    expect(second.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ viewer: 2 }));
  });

  it("does not resend unchanged snapshots, including newly allocated equal results", async () => {
    const sse = sink();
    const stream = await start(sse);
    mocks.forwardTaskDetail.mockImplementation(async () => result(0));
    await vi.advanceTimersByTimeAsync(10_000);
    stream.stop();
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(6);
    expect(sse.send).toHaveBeenCalledTimes(1);
  });

  it("takes the slower read's latency, not the sum of both reads", async () => {
    mocks.forwardTaskDetail.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(result(0)), 120);
    }));
    mocks.forwardTaskPendingRequests.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(pending), 80);
    }));
    const sse = sink();
    const starting = start(sse);
    await vi.advanceTimersByTimeAsync(120);
    const sendsAt120 = sse.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(80);
    const stream = await starting;
    stream.stop();
    expect(sendsAt120).toBe(1);
  });

  it("sends approval changes and clearing even when task detail is unchanged", async () => {
    const sse = sink();
    const stream = await start(sse);
    mocks.forwardTaskPendingRequests.mockResolvedValueOnce({ ...pending, permissionRequest: { requestId: "approval-1" } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ permissionRequest: { requestId: "approval-1" } }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ permissionRequest: null }));
    expect(sse.send).toHaveBeenCalledTimes(3);
    stream.stop();
  });

  it("sends message changes even if updatedAt stays the same", async () => {
    const sse = sink();
    const stream = await start(sse);
    const messages = [{ id: "reply-1", role: "assistant", parts: [{ type: "text", text: "new text" }] }];
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { ...detail(0), messages } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ messages }));
    expect(sse.send).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("detects mutation of a local extra object without task changes", async () => {
    const sse = sink();
    const inbox = { unreadCount: 1 };
    const stream = await startBackendTaskStream({ id: "task-1", sse, extra: () => ({ intercomInbox: inbox }) });
    if (!stream.ok) throw new Error(stream.reason);
    inbox.unreadCount = 2;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenCalledTimes(2);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ intercomInbox: { unreadCount: 2 } }));
    stream.stop();
  });

  it("shares overlapping polls and lets one viewer stop without stopping the other", async () => {
    const first = sink();
    const second = sink();
    const [one, two] = await Promise.all([start(first), start(second)]);
    const slow = deferred<ReturnType<typeof result>>();
    mocks.forwardTaskDetail.mockReturnValueOnce(slow.promise);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(2);
    slow.resolve(result(1));
    await vi.advanceTimersByTimeAsync(0);
    one.stop();
    mocks.forwardTaskDetail.mockResolvedValue(result(2));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.send).toHaveBeenCalledTimes(2);
    expect(second.send).toHaveBeenCalledTimes(3);
    two.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not combine reads of different tasks", async () => {
    const [one, two] = await Promise.all([
      startBackendTaskStream({ id: "task-1", sse: sink() }),
      startBackendTaskStream({ id: "task-2", sse: sink() }),
    ]);
    if (one.ok) one.stop();
    if (two.ok) two.stop();
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledWith("task-2", { messages: "page" });
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(2);
  });

  it("waits for a slow sibling of a rejected read before retrying", async () => {
    const sse = sink();
    const stream = await start(sse);
    const slow = deferred<typeof pending>();
    mocks.forwardTaskDetail.mockRejectedValueOnce(new Error("transport failure"));
    mocks.forwardTaskPendingRequests.mockReturnValueOnce(slow.promise);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    slow.resolve(pending);
    await vi.advanceTimersByTimeAsync(0);
    mocks.forwardTaskDetail.mockResolvedValue(result(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    expect(sse.send).toHaveBeenCalledTimes(2);
    stream.stop();
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
    mocks.forwardTaskDetail.mockResolvedValue(result(1));
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
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["detail", "pending"] as const)("releases the poll after a rejected %s read and retries", async (phase) => {
    const sse = sink();
    const stream = await start(sse);
    mocks.forwardTaskDetail.mockResolvedValue(result(1));
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
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(2);
    mocks.forwardTaskDetail.mockResolvedValue(result(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    expect(sse.send).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("re-reads a getter extra for every snapshot", async () => {
    const sse = sink();
    let inbox = { unreadCount: 1 };
    const stream = await startBackendTaskStream({
      id: "task-1", sse, extra: () => ({ intercomInbox: inbox }),
    });
    if (!stream.ok) throw new Error(stream.reason);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ intercomInbox: { unreadCount: 1 } }));
    inbox = { unreadCount: 2 };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ intercomInbox: { unreadCount: 2 } }));
    stream.stop();
  });

  it("keeps the task snapshot when a getter extra throws", async () => {
    const sse = sink();
    const stream = await startBackendTaskStream({
      id: "task-1", sse, extra: () => { throw new Error("inbox read failed"); },
    });
    if (!stream.ok) throw new Error(stream.reason);
    expect(sse.send).toHaveBeenCalledTimes(1);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ task: { id: "task-1", updatedAt: 0 } }));
    mocks.forwardTaskDetail.mockResolvedValue(result(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("preserves the initial failure contract without starting a timer", async () => {
    mocks.forwardTaskDetail.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    const sse = sink();
    expect(await startBackendTaskStream({ id: "task-1", sse })).toEqual({ ok: false, reason: "unreachable" });
    expect(sse.send).not.toHaveBeenCalled();
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
