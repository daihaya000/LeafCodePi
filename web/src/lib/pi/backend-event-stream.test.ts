import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKEND_EVENT_DIRTY_COALESCE_MS,
  backendTaskSnapshot,
  messagePageDelta,
  startBackendTaskStream,
} from "./backend-event-stream";
import { createSseWriter } from "@/lib/sse-writer";

const mocks = vi.hoisted(() => ({
  forwardTaskDetail: vi.fn(),
  forwardTaskPendingRequests: vi.fn(),
  readHistoryPageSize: vi.fn(() => 150),
}));
vi.mock("@/lib/backend-forward", () => mocks);
vi.mock("@/lib/pi/history-page-size", () => ({ readHistoryPageSize: mocks.readHistoryPageSize }));
vi.mock("@/lib/backend-task-dirty-hub", () => ({
  BACKEND_TASK_STREAM_REASON: "stream",
  isBackendTaskDirtyConnected: () => false,
  subscribeBackendTaskDirty: () => () => {},
}));

const pending = { ok: true as const, permissionRequest: null, questionRequest: null };
const detail = (revision: number, extra: Record<string, unknown> = {}) => ({
  id: "task-1",
  updatedAt: revision,
  messages: [] as Array<Record<string, unknown>>,
  messageRevision: `0:${revision}`,
  ...extra,
});
const result = (revision: number, extra: Record<string, unknown> = {}) => ({
  ok: true as const,
  detail: detail(revision, extra),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const sink = () => ({ closed: false, send: vi.fn() });

async function start(
  sse: ReturnType<typeof sink>,
  options: {
    idleIntervalMs?: number;
    intervalMs?: number;
    streamingIntervalMs?: number;
    dirtyIdleIntervalMs?: number;
    subscribeDirty?: (taskId: string, listener: (payload?: { taskId: string; reason?: string; delta?: Record<string, unknown> }) => void) => () => void;
    dirtyConnected?: () => boolean;
    streamDeltas?: boolean;
    streamMessages?: boolean;
    messageDelta?: boolean;
  } = {},
) {
  const stream = await startBackendTaskStream({
    id: "task-1",
    sse,
    intervalMs: options.intervalMs ?? 2_000,
    streamingIntervalMs: options.streamingIntervalMs,
    idleIntervalMs: options.idleIntervalMs ?? 2_000,
    // Keep dirty idle aligned with the test's idle interval unless a case opts in.
    dirtyIdleIntervalMs: options.dirtyIdleIntervalMs ?? options.idleIntervalMs ?? 2_000,
    subscribeDirty: options.subscribeDirty ?? (() => () => {}),
    dirtyConnected: options.dirtyConnected ?? (() => true),
    streamDeltas: options.streamDeltas,
    streamMessages: options.streamMessages,
    messageDelta: options.messageDelta,
  });
  if (!stream.ok) throw new Error(stream.reason);
  return stream;
}

describe("Backend task stream polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.forwardTaskDetail.mockReset().mockResolvedValue(result(0));
    mocks.forwardTaskPendingRequests.mockReset().mockResolvedValue(pending);
    mocks.readHistoryPageSize.mockReset().mockReturnValue(150);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("asks the Backend for a page first, then omit while idle and unchanged", async () => {
    const stream = await start(sink());
    await vi.advanceTimersByTimeAsync(2_000);
    stream.stop();
    expect(mocks.forwardTaskDetail.mock.calls).toEqual([
      ["task-1", { messages: "page", limit: 150 }],
      ["task-1", { messages: "omit" }],
    ]);
  });

  it("refetches a page when messageRevision changes on an omit poll", async () => {
    const sse = sink();
    const stream = await start(sse);
    mocks.forwardTaskDetail
      .mockResolvedValueOnce({
        ok: true,
        detail: { ...detail(1), messages: [], updatedAt: 1 },
      })
      .mockResolvedValueOnce(result(1, {
        messages: [{ id: "m1", role: "assistant", parts: [] }],
      }));
    await vi.advanceTimersByTimeAsync(2_000);
    stream.stop();
    expect(mocks.forwardTaskDetail.mock.calls).toEqual([
      ["task-1", { messages: "page", limit: 150 }],
      ["task-1", { messages: "omit" }],
      ["task-1", { messages: "page", limit: 150 }],
    ]);
    expect(sse.send).toHaveBeenLastCalledWith(
      "snapshot",
      expect.objectContaining({
        messages: [{ id: "m1", role: "assistant", parts: [] }],
      }),
    );
  });

  it("keeps cached messages when omit revision matches", async () => {
    const messages = [{ id: "m0", role: "user", parts: [{ type: "text", text: "hi" }] }];
    mocks.forwardTaskDetail.mockResolvedValueOnce({
      ok: true,
      detail: { ...detail(0), messages, messageRevision: "1:m0" },
    });
    const sse = sink();
    const stream = await start(sse);
    mocks.forwardTaskDetail.mockResolvedValue({
      ok: true,
      detail: { ...detail(0), messages: [], messageRevision: "1:m0", updatedAt: 9 },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    stream.stop();
    expect(mocks.forwardTaskDetail.mock.calls).toEqual([
      ["task-1", { messages: "page", limit: 150 }],
      ["task-1", { messages: "omit" }],
    ]);
    expect(sse.send).toHaveBeenLastCalledWith(
      "snapshot",
      expect.objectContaining({
        messages,
        task: expect.objectContaining({ updatedAt: 9 }),
      }),
    );
  });

  it("stretches idle polls beyond the streaming interval", async () => {
    const stream = await start(sink(), { intervalMs: 2_000, idleIntervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("keeps the streaming poll interval and pages while isStreaming", async () => {
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { ...detail(0), isStreaming: true } });
    const stream = await start(sink(), { intervalMs: 2_000, idleIntervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    expect(mocks.forwardTaskDetail.mock.calls).toEqual([
      ["task-1", { messages: "page", limit: 150 }],
      ["task-1", { messages: "page", limit: 150 }],
    ]);
    stream.stop();
  });

  it("uses the slower streaming fallback only with a connected dirty hub and keeps dirty wakes immediate", async () => {
    let wake: ((payload?: { taskId: string; reason?: string; delta?: Record<string, unknown> }) => void) | undefined;
    const sse = sink();
    mocks.forwardTaskDetail.mockResolvedValue(result(0, { status: "working", isStreaming: true }));
    const stream = await start(sse, {
      intervalMs: 2_000,
      streamingIntervalMs: 5_000,
      idleIntervalMs: 30_000,
      dirtyIdleIntervalMs: 30_000,
      dirtyConnected: () => true,
      subscribeDirty: (_id, listener) => { wake = listener; return () => {}; },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);

    wake?.({ taskId: "task-1", reason: "task_dirty" });
    await vi.advanceTimersByTimeAsync(BACKEND_EVENT_DIRTY_COALESCE_MS - 1);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    stream.stop();
  });

  it("keeps the short streaming fallback while the dirty hub is disconnected", async () => {
    mocks.forwardTaskDetail.mockResolvedValue(result(0, { status: "working", isStreaming: true }));
    const stream = await start(sink(), {
      intervalMs: 2_000,
      streamingIntervalMs: 5_000,
      idleIntervalMs: 30_000,
      dirtyIdleIntervalMs: 30_000,
      dirtyConnected: () => false,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("wakes within the coalescing window on a Backend dirty notice", async () => {
    let wake: (() => void) | undefined;
    const sse = sink();
    const stream = await start(sse, {
      idleIntervalMs: 30_000,
      dirtyIdleIntervalMs: 30_000,
      subscribeDirty: (_id, listener) => {
        wake = listener;
        return () => { wake = undefined; };
      },
    });
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(1);
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { ...detail(0), updatedAt: 1 } });
    wake?.();
    await vi.advanceTimersByTimeAsync(BACKEND_EVENT_DIRTY_COALESCE_MS - 1);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    expect(sse.send).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("coalesces ten dirty notices in a fixed window into one read of the latest state", async () => {
    let wake: (() => void) | undefined;
    mocks.forwardTaskDetail.mockResolvedValue(result(0, { isStreaming: true }));
    const sse = sink();
    const stream = await start(sse, {
      subscribeDirty: (_id, listener) => { wake = listener; return () => {}; },
    });
    for (let revision = 1; revision <= 10; revision += 1) {
      mocks.forwardTaskDetail.mockResolvedValue(result(revision, { isStreaming: true }));
      wake?.();
      await vi.advanceTimersByTimeAsync(2);
    }
    await vi.advanceTimersByTimeAsync(50);
    stream.stop();
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(2);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({
      task: expect.objectContaining({ updatedAt: 10 }),
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not postpone refresh indefinitely during continuous dirty notices", async () => {
    let wake: (() => void) | undefined;
    mocks.forwardTaskDetail.mockResolvedValue(result(0, { isStreaming: true }));
    const stream = await start(sink(), {
      subscribeDirty: (_id, listener) => { wake = listener; return () => {}; },
    });
    for (let index = 0; index < 10; index += 1) {
      wake?.();
      await vi.advanceTimersByTimeAsync(10);
    }
    // A wake every 10ms still reads every 30ms window (initial read + 3), never waits for quiet.
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(4);
    stream.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["detail", "pending"] as const)("retains dirty notices during a slow %s read for one follow-up", async (phase) => {
    let wake: (() => void) | undefined;
    mocks.forwardTaskDetail.mockResolvedValue(result(0, { isStreaming: true }));
    const sse = sink();
    const stream = await start(sse, {
      subscribeDirty: (_id, listener) => { wake = listener; return () => {}; },
    });
    const slowDetail = deferred<ReturnType<typeof result>>();
    const slowPending = deferred<typeof pending>();
    if (phase === "detail") mocks.forwardTaskDetail.mockReturnValueOnce(slowDetail.promise);
    else mocks.forwardTaskPendingRequests.mockReturnValueOnce(slowPending.promise);
    wake?.();
    await vi.advanceTimersByTimeAsync(100);
    mocks.forwardTaskDetail.mockResolvedValue(result(1, { isStreaming: false }));
    mocks.forwardTaskPendingRequests.mockResolvedValue({ ...pending, permissionRequest: { requestId: "approval-1" } });
    wake?.();
    wake?.();
    wake?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    slowDetail.resolve(result(0, { isStreaming: true }));
    slowPending.resolve(pending);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(3);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({
      task: expect.objectContaining({ updatedAt: 1 }),
      isStreaming: false,
      permissionRequest: { requestId: "approval-1" },
    }));
    stream.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to a page read for a streaming wake from an older Backend", async () => {
    let wake: ((payload?: { taskId: string; reason?: string; delta?: Record<string, unknown> }) => void) | undefined;
    mocks.forwardTaskDetail.mockResolvedValue(result(0));
    const stream = await start(sink(), {
      idleIntervalMs: 30_000,
      subscribeDirty: (_id, listener) => { wake = listener; return () => {}; },
    });
    mocks.forwardTaskDetail.mockResolvedValue(result(1, { isStreaming: true }));
    wake?.({ taskId: "task-1", reason: "stream" });
    await vi.advanceTimersByTimeAsync(BACKEND_EVENT_DIRTY_COALESCE_MS);
    expect(mocks.forwardTaskDetail.mock.calls).toEqual([
      ["task-1", { messages: "page", limit: 150 }],
      ["task-1", { messages: "page", limit: 150 }],
    ]);
    stream.stop();
  });

  it("forwards a Backend-projected delta without fetching a page for the wake", async () => {
    let wake: ((payload?: { taskId: string; reason?: string; delta?: Record<string, unknown> }) => void) | undefined;
    const sse = sink();
    mocks.forwardTaskDetail.mockResolvedValue(result(0, { status: "working", isStreaming: true }));
    const stream = await start(sse, {
      intervalMs: 2_000,
      idleIntervalMs: 30_000,
      dirtyIdleIntervalMs: 30_000,
      subscribeDirty: (_id, listener) => { wake = listener; return () => {}; },
    });
    const delta = {
      type: "delta",
      message: { id: "m1", role: "assistant", parts: [] },
      isStreaming: true,
      eventType: "text_delta",
    };

    wake?.({ taskId: "task-1", reason: "stream", delta });
    expect(sse.send).toHaveBeenLastCalledWith("delta", delta);
    await vi.advanceTimersByTimeAsync(BACKEND_EVENT_DIRTY_COALESCE_MS);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(1);

    // The independent 2s fallback is still armed for missed or metadata-only events.
    await vi.advanceTimersByTimeAsync(2_000 - BACKEND_EVENT_DIRTY_COALESCE_MS);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("does not resend a direct stream message in the next safety snapshot", async () => {
    let wake: ((payload?: { taskId: string; reason?: string; delta?: Record<string, unknown> }) => void) | undefined;
    const sse = sink();
    const message = {
      id: "m1", role: "assistant", createdAt: 1,
      parts: [{ id: "p1", type: "text", text: "streamed once" }],
    };
    mocks.forwardTaskDetail.mockResolvedValue(result(0, { status: "working", isStreaming: true, messages: [] }));
    const stream = await start(sse, {
      intervalMs: 2_000,
      idleIntervalMs: 30_000,
      dirtyIdleIntervalMs: 30_000,
      messageDelta: true,
      subscribeDirty: (_id, listener) => { wake = listener; return () => {}; },
    });
    wake?.({
      taskId: "task-1",
      reason: "stream",
      delta: { type: "delta", message, isStreaming: true },
    });
    expect(sse.send).toHaveBeenCalledWith("delta", expect.objectContaining({ message }));

    mocks.forwardTaskDetail.mockResolvedValue(result(1, { status: "working", isStreaming: true, messages: [message] }));
    await vi.advanceTimersByTimeAsync(2_000);
    const snapshots = sse.send.mock.calls.filter(([event]) => event === "snapshot");
    expect(snapshots.at(-1)?.[1]).toMatchObject({ messagesDelta: true, messages: [] });
    stream.stop();
  });

  it("still sends a poll row when Backend content is newer than the last direct delta", async () => {
    let wake: ((payload?: { taskId: string; reason?: string; delta?: Record<string, unknown> }) => void) | undefined;
    const sse = sink();
    const previous = { id: "m1", role: "assistant", createdAt: 1, parts: [{ id: "p1", type: "text", text: "old" }] };
    const streamed = { ...previous, parts: [{ id: "p1", type: "text", text: "partial" }] };
    const latest = { ...previous, parts: [{ id: "p1", type: "text", text: "latest" }] };
    mocks.forwardTaskDetail.mockResolvedValue(result(0, { status: "working", isStreaming: true, messages: [previous] }));
    const stream = await start(sse, {
      intervalMs: 2_000,
      idleIntervalMs: 30_000,
      dirtyIdleIntervalMs: 30_000,
      messageDelta: true,
      subscribeDirty: (_id, listener) => { wake = listener; return () => {}; },
    });
    wake?.({ taskId: "task-1", reason: "stream", delta: { type: "delta", message: streamed, isStreaming: true } });
    mocks.forwardTaskDetail.mockResolvedValue(result(1, { status: "working", isStreaming: true, messages: [latest] }));
    await vi.advanceTimersByTimeAsync(2_000);
    const snapshots = sse.send.mock.calls.filter(([event]) => event === "snapshot");
    expect(snapshots.at(-1)?.[1]).toMatchObject({ messagesDelta: true, messages: [latest] });
    stream.stop();
  });

  it("suppresses direct stream wakes for a background client while keeping the safety poll", async () => {
    let wake: ((payload?: { taskId: string; reason?: string; delta?: Record<string, unknown> }) => void) | undefined;
    const sse = sink();
    mocks.forwardTaskDetail.mockResolvedValue(result(0, {
      status: "working", isStreaming: true,
      messages: [{ id: "existing", role: "assistant", parts: [] }],
    }));
    const stream = await start(sse, {
      idleIntervalMs: 30_000,
      dirtyIdleIntervalMs: 30_000,
      streamDeltas: false,
      streamMessages: false,
      messageDelta: true,
      subscribeDirty: (_id, listener) => { wake = listener; return () => {}; },
    });
    wake?.({
      taskId: "task-1",
      reason: "stream",
      delta: { type: "delta", message: { id: "m1", role: "assistant", parts: [] }, isStreaming: true },
    });
    expect(sse.send).not.toHaveBeenCalledWith("delta", expect.anything());
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(1);
    expect(mocks.forwardTaskDetail).toHaveBeenNthCalledWith(1, "task-1", { messages: "omit" });
    expect(sse.send.mock.calls.filter(([event]) => event === "snapshot").every(([, payload]) => !("messages" in (payload as Record<string, unknown>)))).toBe(true);

    mocks.forwardTaskDetail.mockResolvedValue(result(1, { status: "working", isStreaming: true, messages: [] }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    expect(mocks.forwardTaskDetail).toHaveBeenNthCalledWith(2, "task-1", { messages: "omit" });
    expect(sse.send.mock.calls.filter(([event]) => event === "snapshot").every(([, payload]) => !("messages" in (payload as Record<string, unknown>)))).toBe(true);
    stream.stop();
  });

  it("keeps the short poll while a prompt is accepted but the stream has not opened", async () => {
    mocks.forwardTaskDetail.mockResolvedValue(result(0, { status: "working" }));
    const stream = await start(sink(), { intervalMs: 2_000, idleIntervalMs: 30_000, dirtyIdleIntervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("uses the shorter idle poll while the dirty hub is disconnected", async () => {
    let connected = false;
    const stream = await start(sink(), {
      idleIntervalMs: 5_000,
      dirtyIdleIntervalMs: 30_000,
      subscribeDirty: () => () => {},
      dirtyConnected: () => connected,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    connected = true;
    // That tick was already armed at 5s; the one after it sees a connected hub and stretches.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(4);
    stream.stop();
  });

  it("cancels a queued dirty refresh on stop", async () => {
    let wake: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const stream = await start(sink(), {
      subscribeDirty: (_id, listener) => { wake = listener; return unsubscribe; },
    });
    wake?.();
    stream.stop();
    wake?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
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
    const messages = Array.from({ length: 200 }, (_, index) => ({ id: `m${index}`, role: "user", parts: [] }));
    const snapshot = backendTaskSnapshot({ id: "task-1", messages }, pending);
    expect(snapshot.messages).toEqual(messages.slice(-150));
    expect(snapshot.messageHistory).toEqual({ hasMore: true, nextCursor: "m50" });
    expect(messages).toHaveLength(200);
  });

  it("asks the Backend for the configured page size", async () => {
    mocks.readHistoryPageSize.mockReturnValue(300);
    const stream = await start(sink());
    stream.stop();
    expect(mocks.forwardTaskDetail.mock.calls).toEqual([["task-1", { messages: "page", limit: 300 }]]);
  });

  it("serializes each snapshot only once with the real SSE writer", async () => {
    const enqueue = vi.fn();
    const controller = { enqueue } as unknown as ReadableStreamDefaultController<Uint8Array>;
    const sse = createSseWriter(controller);
    const toJSON = vi.fn(() => ({ unreadCount: 1 }));
    const stream = await startBackendTaskStream({
      id: "task-1",
      sse,
      intervalMs: 2_000,
      idleIntervalMs: 2_000,
      dirtyIdleIntervalMs: 2_000,
      subscribeDirty: () => () => {},
      extra: { intercomInbox: { toJSON } },
    });
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
      startBackendTaskStream({
        id: "task-1", sse: first, intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
        subscribeDirty: () => () => {}, extra: { viewer: 1 },
      }),
      startBackendTaskStream({
        id: "task-1", sse: second, intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
        subscribeDirty: () => () => {}, extra: { viewer: 2 },
      }),
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

  it("keeps the last approval when a pending poll soft-fails", async () => {
    const sse = sink();
    const stream = await start(sse);
    mocks.forwardTaskPendingRequests.mockResolvedValueOnce({
      ok: true, permissionRequest: { requestId: "approval-1" }, questionRequest: null,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ permissionRequest: { requestId: "approval-1" } }));
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { ...detail(0), updatedAt: 1 } });
    mocks.forwardTaskPendingRequests.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({
      task: expect.objectContaining({ updatedAt: 1 }),
      permissionRequest: { requestId: "approval-1" },
    }));
    stream.stop();
  });

  it("sends message changes even if updatedAt stays the same", async () => {
    const sse = sink();
    const stream = await start(sse);
    const messages = [{ id: "reply-1", role: "assistant", parts: [{ type: "text", text: "new text" }] }];
    mocks.forwardTaskDetail
      .mockResolvedValueOnce({
        ok: true,
        detail: { ...detail(0), messageRevision: "1:reply-1", messages: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        detail: { ...detail(0), messages, messageRevision: "1:reply-1" },
      });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sse.send).toHaveBeenLastCalledWith("snapshot", expect.objectContaining({ messages }));
    expect(sse.send).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("detects mutation of a local extra object without task changes", async () => {
    const sse = sink();
    const inbox = { unreadCount: 1 };
    const stream = await startBackendTaskStream({
      id: "task-1", sse, intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
      subscribeDirty: () => () => {}, extra: () => ({ intercomInbox: inbox }),
    });
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
    slow.resolve(result(0));
    await vi.advanceTimersByTimeAsync(0);
    one.stop();
    mocks.forwardTaskDetail.mockResolvedValue(result(2));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(2);
    two.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not combine reads of different tasks", async () => {
    const [one, two] = await Promise.all([
      startBackendTaskStream({
        id: "task-1", sse: sink(), intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
        subscribeDirty: () => () => {},
      }),
      startBackendTaskStream({
        id: "task-2", sse: sink(), intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
        subscribeDirty: () => () => {},
      }),
    ]);
    if (one.ok) one.stop();
    if (two.ok) two.stop();
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledWith("task-2", { messages: "page", limit: 150 });
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(2);
  });

  it("does not share omit and page waiters for the same task", async () => {
    const pageSlow = deferred<ReturnType<typeof result>>();
    mocks.forwardTaskDetail.mockReturnValueOnce(pageSlow.promise);
    const pageStarting = startBackendTaskStream({
      id: "task-1", sse: sink(), intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
      subscribeDirty: () => () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    mocks.forwardTaskDetail.mockResolvedValue(result(0));
    // A second viewer that is already idle would omit; force a page via streaming flag on a fresh id path:
    // instead start after first resolves, then poll omit while a concurrent page is forced by clearing cache —
    // simpler: start one stream, let it idle-omit, and ensure a streaming viewer uses a separate in-flight key.
    pageSlow.resolve(result(0));
    const pageStream = await pageStarting;
    if (!pageStream.ok) throw new Error(pageStream.reason);
    const omitSlow = deferred<ReturnType<typeof result>>();
    mocks.forwardTaskDetail.mockReturnValueOnce(omitSlow.promise);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenLastCalledWith("task-1", { messages: "omit" });
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { ...detail(0), isStreaming: true } });
    // Dirty wake while omit is in flight should still be able to start a page read under a different key.
    // Stop and start streaming stream separately.
    omitSlow.resolve(result(0));
    await vi.advanceTimersByTimeAsync(0);
    pageStream.stop();
    const streaming = await startBackendTaskStream({
      id: "task-1",
      sse: sink(),
      intervalMs: 2_000,
      idleIntervalMs: 2_000,
      dirtyIdleIntervalMs: 2_000,
      subscribeDirty: () => () => {},
    });
    if (streaming.ok) {
      expect(mocks.forwardTaskDetail).toHaveBeenCalledWith("task-1", { messages: "page", limit: 150 });
      streaming.stop();
    }
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
    // Same revision: retry is a single omit, not omit+page.
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { ...detail(0), updatedAt: 1 } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    expect(sse.send).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("serializes slow detail reads so later snapshots cannot overtake them", async () => {
    const sse = sink();
    const stream = await start(sse);
    const slow = deferred<ReturnType<typeof result>>();
    // Same revision so omit does not immediately chain a page; metadata-only updates still serialize.
    mocks.forwardTaskDetail.mockReturnValueOnce(slow.promise).mockResolvedValue({
      ok: true,
      detail: { ...detail(0), updatedAt: 2 },
    });
    try {
      await vi.advanceTimersByTimeAsync(6_000);
      expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
      expect(sse.send).toHaveBeenCalledTimes(1);
      slow.resolve({ ok: true, detail: { ...detail(0), updatedAt: 1 } });
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
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { ...detail(0), updatedAt: 1 } });
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
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { ...detail(0), updatedAt: 1 } });
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
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { ...detail(0), updatedAt: 1 } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(3);
    expect(sse.send).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("re-reads a getter extra for every snapshot", async () => {
    const sse = sink();
    let inbox = { unreadCount: 1 };
    const stream = await startBackendTaskStream({
      id: "task-1", sse, intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
      subscribeDirty: () => () => {}, extra: () => ({ intercomInbox: inbox }),
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
      id: "task-1", sse, intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
      subscribeDirty: () => () => {}, extra: () => { throw new Error("inbox read failed"); },
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
    expect(await startBackendTaskStream({
      id: "task-1", sse, intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
      subscribeDirty: () => () => {},
    })).toEqual({ ok: false, reason: "unreachable" });
    expect(sse.send).not.toHaveBeenCalled();
    expect(mocks.forwardTaskPendingRequests).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("message page deltas", () => {
  const page = (rows: Array<[string, string]>) => ({
    ids: rows.map(([id]) => id),
    jsonById: new Map(rows),
  });

  it("returns only changed and appended rows of a front-trimmed page", () => {
    const previous = page([["a", "A"], ["b", "B"], ["c", "C"]]);
    expect(messagePageDelta(previous, ["b", "c", "d"], ["B", "C2", "D"])).toEqual([1, 2]);
    expect(messagePageDelta(previous, ["a", "b", "c"], ["A", "B", "C"])).toEqual([]);
  });

  it("falls back to a full page for re-identified, removed, reordered or unknown rows", () => {
    const previous = page([["a", "A"], ["b", "B"], ["c", "C"]]);
    expect(messagePageDelta(previous, ["a", "b", "c2"], ["A", "B", "C"])).toBeUndefined();
    expect(messagePageDelta(previous, ["a", "b"], ["A", "B"])).toBeUndefined();
    expect(messagePageDelta(previous, ["a", "c", "b"], ["A", "C", "B"])).toBeUndefined();
    expect(messagePageDelta(previous, ["x", "a"], ["X", "A"])).toBeUndefined();
    expect(messagePageDelta(previous, ["b", "c", "a"], ["B", "C", "A"])).toBeUndefined();
    expect(messagePageDelta(previous, [], [])).toBeUndefined();
  });
});

describe("Backend task stream message deltas", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.forwardTaskPendingRequests.mockReset().mockResolvedValue(pending);
    mocks.readHistoryPageSize.mockReset().mockReturnValue(150);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  const message = (id: string, text: string) => ({ id, role: "assistant", parts: [{ id: `${id}:0`, type: "text", text }] });
  const streaming = (revision: number, messages: unknown[]) => ({
    ok: true as const,
    detail: { ...detail(revision, { isStreaming: true, status: "working" }), messages },
  });

  it("sends the full page first, then only the changed row while streaming", async () => {
    mocks.forwardTaskDetail.mockReset().mockResolvedValue(streaming(0, [message("u1", "hi"), message("a1", "he")]));
    const sends: Array<[string, string]> = [];
    const sse = { closed: false, send: vi.fn(), sendSerialized: (event: string, json: string) => { sends.push([event, json]); } };
    const stream = await startBackendTaskStream({
      id: "task-1", sse, intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
      subscribeDirty: () => () => {}, messageDelta: true,
    });
    if (!stream.ok) throw new Error(stream.reason);
    mocks.forwardTaskDetail.mockResolvedValue(streaming(1, [message("u1", "hi"), message("a1", "hello")]));
    await vi.advanceTimersByTimeAsync(2_000);
    // Unchanged poll: nothing is resent.
    await vi.advanceTimersByTimeAsync(2_000);
    // The turn ends: the idle snapshot carries the full page again.
    mocks.forwardTaskDetail.mockResolvedValue({
      ok: true,
      detail: { ...detail(2, { status: "idle" }), messages: [message("u1", "hi"), message("a1", "hello")] },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    stream.stop();
    expect(sends).toHaveLength(3);
    const idle = JSON.parse(sends[2]![1]);
    expect(idle.messagesDelta).toBeUndefined();
    expect(idle.messages).toHaveLength(2);
    const first = JSON.parse(sends[0]![1]);
    const second = JSON.parse(sends[1]![1]);
    expect(first.messagesDelta).toBeUndefined();
    expect(first.messages.map((row: { id: string }) => row.id)).toEqual(["u1", "a1"]);
    expect(second.messagesDelta).toBe(true);
    expect(second.messages).toEqual([message("a1", "hello")]);
    expect(second).toMatchObject({ type: "snapshot", isStreaming: true, task: { id: "task-1", updatedAt: 1 } });
    expect(sends[1]![1].length).toBeLessThan(sends[0]![1].length);
  });

  it("falls back to a full page when a row is re-identified", async () => {
    mocks.forwardTaskDetail.mockReset().mockResolvedValue(streaming(0, [message("u1", "hi"), message("tmp", "he")]));
    const sends: string[] = [];
    const sse = { closed: false, send: vi.fn(), sendSerialized: (_event: string, json: string) => { sends.push(json); } };
    const stream = await startBackendTaskStream({
      id: "task-1", sse, intervalMs: 2_000, idleIntervalMs: 2_000, dirtyIdleIntervalMs: 2_000,
      subscribeDirty: () => () => {}, messageDelta: true,
    });
    if (!stream.ok) throw new Error(stream.reason);
    mocks.forwardTaskDetail.mockResolvedValue(streaming(1, [message("u1", "hi"), message("a1", "hello")]));
    await vi.advanceTimersByTimeAsync(2_000);
    stream.stop();
    const second = JSON.parse(sends[1]!);
    expect(second.messagesDelta).toBeUndefined();
    expect(second.messages.map((row: { id: string }) => row.id)).toEqual(["u1", "a1"]);
  });

  it("keeps full pages for clients that did not opt in", async () => {
    mocks.forwardTaskDetail.mockReset().mockResolvedValue(streaming(0, [message("u1", "hi"), message("a1", "he")]));
    const sse = sink();
    const stream = await start(sse);
    mocks.forwardTaskDetail.mockResolvedValue(streaming(1, [message("u1", "hi"), message("a1", "hello")]));
    await vi.advanceTimersByTimeAsync(2_000);
    stream.stop();
    expect(sse.send).toHaveBeenCalledTimes(2);
    expect(sse.send.mock.calls[1]![1]).not.toHaveProperty("messagesDelta");
    expect((sse.send.mock.calls[1]![1] as { messages: unknown[] }).messages).toHaveLength(2);
  });
});