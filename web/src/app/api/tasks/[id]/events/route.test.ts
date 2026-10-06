import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@/lib/types";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  getTaskBootstrap: vi.fn(),
  getTaskDetail: vi.fn(),
  isTaskRuntimeOwnedElsewhere: vi.fn(() => false),
  pendingPermissionForTask: vi.fn(),
  pendingQuestionForTask: vi.fn(),
  subscribeTask: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskDetail: vi.fn(),
  forwardTaskPendingRequests: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);
vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({
  forwardTaskDetail: mocks.forwardTaskDetail,
  forwardTaskPendingRequests: mocks.forwardTaskPendingRequests,
  forwardTaskAbort: vi.fn(),
  forwardTaskPrompt: vi.fn(),
  forwardPermissionAnswer: vi.fn(),
  forwardQuestionAnswer: vi.fn(),
  needsLocalResolution: vi.fn(() => false),
  forwardablePromptBody: vi.fn((body) => body),
}));

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "task-1",
    projectId: "project-1",
    projectName: "Project",
    title: "SSEを安定化する",
    directory: "C:\\project",
    isolation: "current_folder",
    status: "working",
    sessionId: "session-1",
    sessionFile: "C:\\session.jsonl",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    isStreaming: true,
    isCompacting: false,
    ...overrides,
  };
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  return new TextDecoder().decode(chunk.value);
}

function eventData(chunk: string): Record<string, unknown> {
  const line = chunk.split("\n").find((value) => value.startsWith("data: "));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice("data: ".length)) as Record<string, unknown>;
}

describe("/api/tasks/[id]/events", () => {
  beforeEach(() => {
    mocks.getTask.mockReset();
    mocks.getTaskBootstrap.mockReset();
    mocks.getTaskDetail.mockReset();
    mocks.isTaskRuntimeOwnedElsewhere.mockReset().mockReturnValue(false);
    mocks.pendingPermissionForTask.mockReset().mockReturnValue(null);
    mocks.pendingQuestionForTask.mockReset().mockReturnValue(null);
    mocks.subscribeTask.mockReset();
    mocks.localRuntimeBlocked.mockReset().mockReturnValue(false);
    mocks.forwardTaskDetail.mockReset();
    mocks.forwardTaskPendingRequests.mockReset().mockResolvedValue({ ok: true, permissionRequest: null, questionRequest: null });
  });

  it("streams from the owning Backend without subscribing locally after the cutover", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValue({
      ok: true,
      detail: task({ messages: [], isStreaming: true, status: "working" }),
    });
    mocks.forwardTaskPendingRequests.mockResolvedValue({
      ok: true, permissionRequest: { requestId: "req-1" },
      questionRequest: null,
    });
    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/events"), {
      params: Promise.resolve({ id: "task-1" }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const chunk = await readChunk(reader);
    const payload = eventData(chunk);
    expect(payload.eventType).toBe("remote_poll");
    expect(payload.isStreaming).toBe(true);
    // The pending approval lives in the Backend, so it must come from there.
    expect(payload.permissionRequest).toEqual({ requestId: "req-1" });
    expect(payload.questionRequest).toBeNull();
    // Nothing local: no bootstrap read and no in-process subscription.
    expect(mocks.getTaskBootstrap).not.toHaveBeenCalled();
    expect(mocks.subscribeTask).not.toHaveBeenCalled();
    await reader.cancel();
  });

  it("refreshes Backend detail on every poll and stops polling after cancellation", async () => {
    vi.useFakeTimers();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      mocks.localRuntimeBlocked.mockReturnValue(true);
      const updated = task({
        status: "idle", isStreaming: false, updatedAt: "2026-01-01T00:00:02.000Z",
        messages: [{ id: "done", role: "assistant", createdAt: 2, parts: [{ id: "text", type: "text", text: "完了" }] }],
      });
      mocks.forwardTaskDetail
        .mockResolvedValueOnce({ ok: true, detail: task() })
        .mockResolvedValue({ ok: true, detail: updated });
      mocks.forwardTaskPendingRequests
        .mockResolvedValueOnce({ ok: true, permissionRequest: { requestId: "req-1" }, questionRequest: null })
        .mockResolvedValue({ ok: true, permissionRequest: null, questionRequest: null });
      const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/events"), {
        params: Promise.resolve({ id: "task-1" }),
      });
      reader = response.body!.getReader();
      expect(eventData(await readChunk(reader)).isStreaming).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
      const refreshed = eventData(await readChunk(reader));
      expect(refreshed.task).toMatchObject({ status: "idle", updatedAt: updated.updatedAt });
      expect(refreshed.messages).toEqual(updated.messages);
      expect(refreshed.isStreaming).toBe(false);
      expect(refreshed.permissionRequest).toBeNull();
      expect(mocks.getTaskBootstrap).not.toHaveBeenCalled();
      expect(mocks.subscribeTask).not.toHaveBeenCalled();
      await reader.cancel();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await reader?.cancel();
      vi.useRealTimers();
    }
  });

  it("ends the stream with an error when the Backend cannot be read", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "unreachable" });
    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/events"), {
      params: Promise.resolve({ id: "task-1" }),
    });
    const chunk = await readChunk(response.body!.getReader());
    expect(chunk).toContain("event: error");
    expect(mocks.subscribeTask).not.toHaveBeenCalled();
  });

  it("unsubscribes when the request is already aborted before task subscription", async () => {
    const bootstrap = task({ messages: [], isStreaming: false, status: "idle" });
    const unsubscribe = vi.fn();
    const request = new AbortController();
    request.abort();
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.subscribeTask.mockReturnValue(unsubscribe);

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events", { signal: request.signal }),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    await response.body?.cancel();

    expect(mocks.subscribeTask).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.getTaskDetail).not.toHaveBeenCalled();
  });

  it("buffers live deltas until the ready snapshot is sent", async () => {
    const bootstrap = task({ messages: [], isStreaming: true });
    const detail = task({
      messages: [{ id: "history", role: "user", createdAt: 1, parts: [{ id: "part", type: "text", text: "履歴" }] }],
      isStreaming: false,
      status: "idle",
    });
    let resolveDetail!: (value: TaskDetail) => void;
    let listener!: (payload: Record<string, unknown>) => void;
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockReturnValue(new Promise<TaskDetail>((resolve) => {
      resolveDetail = resolve;
    }));
    mocks.subscribeTask.mockImplementation((_id: string, callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    });

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    expect(response.headers.get("cache-control")).toBe("no-store, no-cache, no-transform");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
    const reader = response.body!.getReader();

    const bootstrapChunk = await readChunk(reader);
    expect(bootstrapChunk).toContain("event: snapshot\n");
    expect(eventData(bootstrapChunk).eventType).toBe("bootstrap");
    expect(mocks.subscribeTask).toHaveBeenCalledOnce();

    listener({
      type: "delta",
      task: task({ status: "working" }),
      message: { id: "live", role: "assistant", createdAt: 2, parts: [] },
    });
    const readyTaskSummary = { ...detail } as Record<string, unknown>;
    for (const key of [
      "messages", "isStreaming", "isCompacting", "contextUsage", "compactionSuggested", "goalLoop", "todos",
      "permissionRequest", "questionRequest", "manualAbortedAssistantId", "hangRetryCount",
    ]) delete readyTaskSummary[key];
    listener({
      type: "snapshot",
      task: readyTaskSummary,
      messages: [{ id: "intermediate", role: "user", createdAt: 2, parts: [] }],
      eventType: "intermediate",
    });
    listener({
      type: "delta",
      message: { id: "live-latest", role: "assistant", createdAt: 3, parts: [] },
    });
    resolveDetail(detail);

    const readyChunk = await readChunk(reader);
    const readyPayload = eventData(readyChunk);
    expect(readyPayload.eventType).toBe("ready");
    expect(readyPayload.task).not.toHaveProperty("messages");
    expect(readyPayload.task).not.toHaveProperty("isStreaming");
    const pendingSnapshotChunk = await readChunk(reader);
    expect(pendingSnapshotChunk).toContain("event: snapshot\n");
    const pendingSnapshot = eventData(pendingSnapshotChunk);
    expect(pendingSnapshot).toMatchObject({ eventType: "intermediate", taskReused: true });
    expect(pendingSnapshot).not.toHaveProperty("task");
    const deltaChunk = await readChunk(reader);
    expect(deltaChunk).toContain("event: delta\n");
    const deltaPayload = eventData(deltaChunk);
    expect(deltaPayload.type).toBe("delta");
    expect(deltaPayload.message).toMatchObject({ id: "live-latest", role: "assistant" });
    expect(deltaPayload).not.toHaveProperty("messages");
    expect(deltaPayload).not.toHaveProperty("task");

    await reader.cancel();
  });

  it("suppresses high-frequency delta events when the client disables background streaming", async () => {
    const bootstrap = task({ messages: [], status: "working", isStreaming: true });
    let listener!: (payload: Record<string, unknown>) => void;
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockResolvedValue(bootstrap);
    mocks.subscribeTask.mockImplementation((_id: string, callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    });
    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events?streamDeltas=0&streamMessages=0"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    const bootstrapPayload = eventData(await readChunk(reader));
    expect(bootstrapPayload).not.toHaveProperty("messages");
    const readyPayload = eventData(await readChunk(reader));
    expect(readyPayload).not.toHaveProperty("messages");
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("task-1", expect.objectContaining({ includeMessages: false }));

    listener({ type: "delta", message: { id: "high-frequency", role: "assistant", createdAt: 2, parts: [] } });
    listener({
      type: "snapshot", eventType: "permission_request", permissionRequest: { requestId: "req-1" },
      messages: [{ id: "hidden-history", role: "assistant", createdAt: 2, parts: [] }],
    });
    const controlChunk = await readChunk(reader);
    expect(controlChunk).toContain("event: snapshot\n");
    expect(eventData(controlChunk).eventType).toBe("permission_request");
    expect(eventData(controlChunk).permissionRequest).toEqual({ requestId: "req-1" });
    expect(eventData(controlChunk)).not.toHaveProperty("messages");
    await reader.cancel();
  });

  it("omits ready history when the idle client cache revision matches", async () => {
    const bootstrap = task({ messages: [], isStreaming: false, status: "idle" });
    const detail = task({
      messages: [{ id: "history", role: "user", createdAt: 1, parts: [{ id: "part", type: "text", text: "履歴" }] }],
      isStreaming: false,
      status: "idle",
    });
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockResolvedValue(detail);
    mocks.subscribeTask.mockReturnValue(vi.fn());

    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3010/api/tasks/task-1/events?cachedTaskUpdatedAt=2026-01-01T00%3A00%3A00.000Z&cachedSessionId=session-1",
      ),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    await readChunk(reader);

    const cachedReadyPayload = eventData(await readChunk(reader));
    expect(cachedReadyPayload.eventType).toBe("cache_ready");
    expect(cachedReadyPayload.messagesReused).toBe(true);
    expect(cachedReadyPayload.taskReused).toBe(true);
    expect(cachedReadyPayload).not.toHaveProperty("task");
    const readyPayload = eventData(await readChunk(reader));
    expect(readyPayload.eventType).toBe("ready");
    expect(readyPayload.messagesReused).toBe(true);
    expect(readyPayload).not.toHaveProperty("messages");
    expect(mocks.getTaskDetail).toHaveBeenCalledOnce();
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("task-1", { includeMessages: false });

    await reader.cancel();
  });

  it("loads ready history when a cached silent turn could auto-resume", async () => {
    const bootstrap = task({ messages: [], isStreaming: false, status: "idle" });
    const detail = task({
      messages: [
        { id: "prompt", role: "user", createdAt: 1, parts: [{ id: "prompt-part", type: "text", text: "指示" }] },
        { id: "reply", role: "assistant", createdAt: 2, parts: [{ id: "reply-part", type: "text", text: "完了" }] },
      ],
      isStreaming: false,
      status: "idle",
    });
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockResolvedValue(detail);
    mocks.subscribeTask.mockReturnValue(vi.fn());

    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3010/api/tasks/task-1/events?cachedTaskUpdatedAt=2026-01-01T00%3A00%3A00.000Z&cachedSessionId=session-1&cachedSilentResumeCandidate=1",
      ),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    await readChunk(reader);
    expect(eventData(await readChunk(reader)).eventType).toBe("cache_ready");

    const readyPayload = eventData(await readChunk(reader));
    expect(readyPayload.eventType).toBe("ready");
    expect(readyPayload.messages).toEqual(detail.messages);
    expect(readyPayload.messagesReused).toBeUndefined();
    expect(mocks.getTaskDetail).toHaveBeenCalledOnce();
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("task-1");

    await reader.cancel();
  });

  it("releases cached clients before cold detail hydration finishes", async () => {
    const bootstrap = task({ messages: [], isStreaming: false, status: "idle" });
    const detail = task({
      messages: [{ id: "history", role: "user", createdAt: 1, parts: [{ id: "part", type: "text", text: "履歴" }] }],
      isStreaming: false,
      status: "idle",
    });
    let resolveDetail!: (value: TaskDetail) => void;
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockReturnValue(new Promise<TaskDetail>((resolve) => {
      resolveDetail = resolve;
    }));
    mocks.subscribeTask.mockReturnValue(vi.fn());

    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3010/api/tasks/task-1/events?cachedTaskUpdatedAt=2026-01-01T00%3A00%3A00.000Z&cachedSessionId=session-1",
      ),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    expect(eventData(await readChunk(reader)).eventType).toBe("bootstrap");

    const cachedReady = eventData(await readChunk(reader));
    expect(cachedReady.eventType).toBe("cache_ready");
    expect(cachedReady.messagesReused).toBe(true);
    expect(cachedReady.taskReused).toBe(true);
    expect(cachedReady).not.toHaveProperty("task");
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("task-1", { includeMessages: false });

    resolveDetail(detail);
    expect(eventData(await readChunk(reader)).eventType).toBe("ready");
    await reader.cancel();
  });

  it("reuses unchanged Goal Loop and attention payloads in an in-process snapshot", async () => {
    const bootstrap = task({ messages: [], isStreaming: false, status: "idle" });
    const goalLoop = {
      id: "loop-1", status: "running", goal: "繰り返し確認する", acceptance: ["状態が安定"],
      maxTurns: 5, turnCount: 1, progress: [],
    } as unknown as NonNullable<TaskDetail["goalLoop"]>;
    const todos = Array.from({ length: 8 }, (_, index) => ({
      id: `todo-${index}`, content: `変更内容を確認する ${index}`, status: "in_progress" as const, priority: "high" as const,
    })) as NonNullable<TaskDetail["todos"]>;
    const contextUsage = { tokens: 20, contextWindow: 100, percent: 20 };
    const permissionRequest = {
      id: "req-1", sessionId: "session-1", message: "許可を確認する", command: "echo ".repeat(80), labels: [],
    };
    const questionRequest = {
      id: "question-1", sessionId: "session-1", questions: [{ question: "どちらですか", options: ["A", "B"] }],
    };
    const detail = task({ messages: [], isStreaming: false, status: "idle", goalLoop, todos, contextUsage });
    let listener!: (payload: Record<string, unknown>) => void;
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockResolvedValue(detail);
    mocks.pendingPermissionForTask.mockReturnValue(permissionRequest);
    mocks.pendingQuestionForTask.mockReturnValue(questionRequest);
    mocks.subscribeTask.mockImplementation((_id: string, callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    });

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    expect(eventData(await readChunk(reader)).eventType).toBe("bootstrap");
    const ready = eventData(await readChunk(reader));
    expect(ready.eventType).toBe("ready");

    listener({
      type: "snapshot",
      task: ready.task as Record<string, unknown>,
      messages: [],
      isStreaming: false,
      contextUsage,
      goalLoop,
      todos,
      permissionRequest,
      questionRequest,
      eventType: "context_update",
    });
    const updated = eventData(await readChunk(reader));
    expect(updated).toMatchObject({ eventType: "context_update", taskReused: true });
    for (const field of ["task", "goalLoop", "todos", "permissionRequest", "questionRequest", "contextUsage"]) {
      expect(updated).not.toHaveProperty(field);
    }
    const fullEquivalent = { ...updated, goalLoop, todos, permissionRequest, questionRequest, contextUsage };
    expect(JSON.stringify(updated).length).toBeLessThan(JSON.stringify(fullEquivalent).length);
    await reader.cancel();
  });

  it("polls a foreign Bot Code task until its owner releases the lease", async () => {
    vi.useFakeTimers();
    try {
      const bootstrap = task({ kind: "code", botId: "bot-1", status: "working", isStreaming: true });
      const initialDetail = task({ kind: "code", botId: "bot-1", status: "working", isStreaming: true });
      const finalDetail = task({
        kind: "code",
        botId: "bot-1",
        status: "idle",
        isStreaming: false,
        messages: [{ id: "final", role: "assistant", createdAt: 1, parts: [] }],
      });
      let currentTask: TaskDetail = bootstrap;
      mocks.getTaskBootstrap.mockReturnValue(bootstrap);
      mocks.getTask.mockImplementation(() => currentTask);
      mocks.getTaskDetail
        .mockResolvedValueOnce(initialDetail)
        .mockImplementationOnce(async (_id: string, options?: { offline?: boolean }) => {
          expect(options?.offline).toBe(true);
          currentTask = finalDetail;
          return finalDetail;
        });
      mocks.isTaskRuntimeOwnedElsewhere
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
      mocks.subscribeTask.mockReturnValue(vi.fn());

      const response = await GET(
        new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
        { params: Promise.resolve({ id: "task-1" }) },
      );
      const reader = response.body!.getReader();
      await readChunk(reader);
      expect(eventData(await readChunk(reader)).eventType).toBe("ready");

      await vi.advanceTimersByTimeAsync(2_000);
      const remotePayload = eventData(await readChunk(reader));
      expect(remotePayload.eventType).toBe("remote_poll");
      expect(remotePayload.messages).toEqual(finalDetail.messages);
      expect(remotePayload).not.toHaveProperty("permissionRequest");
      expect(remotePayload).not.toHaveProperty("questionRequest");
      expect(mocks.getTaskDetail).toHaveBeenLastCalledWith("task-1", { offline: true });

      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the remote poll snapshot while the foreign detail is unchanged", async () => {
    vi.useFakeTimers();
    try {
      const bootstrap = task({ kind: "code", botId: "bot-1", status: "working", isStreaming: true });
      const earlierMessages = Array.from({ length: 5 }, (_, index) => ({
        id: `history-${index}`, role: "user" as const, createdAt: index + 1, parts: [],
      }));
      const first = task({
        kind: "code", botId: "bot-1", status: "idle", isStreaming: false,
        messages: [...earlierMessages, { id: "final", role: "assistant", createdAt: 6, parts: [] }],
      });
      mocks.getTaskBootstrap.mockReturnValue(bootstrap);
      mocks.getTask.mockReturnValue(bootstrap);
      mocks.getTaskDetail.mockResolvedValue(first);
      mocks.isTaskRuntimeOwnedElsewhere.mockReturnValue(true);
      mocks.subscribeTask.mockReturnValue(vi.fn());

      const response = await GET(
        new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events?delta=1"),
        { params: Promise.resolve({ id: "task-1" }) },
      );
      const reader = response.body!.getReader();
      await readChunk(reader);
      expect(eventData(await readChunk(reader)).eventType).toBe("ready");

      // The ready snapshot is already authoritative, so an identical first poll sends no duplicate.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mocks.getTaskDetail).toHaveBeenCalledTimes(2);

      const updatedMessage = {
        id: "final", role: "assistant", createdAt: 6,
        parts: [{ id: "p1", type: "text", text: "updated" }],
      };
      const updatedTask = {
        ...first,
        updatedAt: "2026-01-01T00:00:01.000Z",
        messages: [...earlierMessages, updatedMessage],
      };
      mocks.getTaskDetail.mockResolvedValue(updatedTask);
      await vi.advanceTimersByTimeAsync(4_000);
      const changed = eventData(await readChunk(reader));
      expect(changed.eventType).toBe("remote_poll");
      expect(changed.messagesDelta).toBe(true);
      expect(changed.messages).toEqual([updatedMessage]);

      mocks.getTaskDetail.mockResolvedValue({
        ...updatedTask,
        messages: [...earlierMessages, updatedMessage, { id: "next", role: "assistant", createdAt: 7, parts: [] }],
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const appended = eventData(await readChunk(reader));
      expect(appended.messagesDelta).toBe(true);
      expect(appended.messages).toEqual([{ id: "next", role: "assistant", createdAt: 7, parts: [] }]);

      // A last-row re-identification is detected even when updatedAt and page length are stable.
      mocks.getTaskDetail.mockResolvedValue({
        ...updatedTask,
        messages: [...earlierMessages, updatedMessage, { id: "rewritten", role: "assistant", createdAt: 7, parts: [] }],
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const rewritten = eventData(await readChunk(reader));
      expect(rewritten.eventType).toBe("remote_poll");
      expect(rewritten).not.toHaveProperty("messagesDelta");
      expect((rewritten.messages as Array<{ id: string }>).at(-1)?.id).toBe("rewritten");

      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resend a foreign-owner page when cached-ready revision still matches", async () => {
    vi.useFakeTimers();
    try {
      const updatedAt = "2026-01-01T00:00:00.000Z";
      const bootstrap = task({ status: "idle", isStreaming: false, updatedAt, messages: [] });
      const history = Array.from({ length: 5 }, (_, index) => ({
        id: `history-${index}`, role: "user" as const, createdAt: index + 1, parts: [],
      }));
      const lastMessage = { id: "final", role: "assistant" as const, createdAt: 6, parts: [] };
      const cachedMessages = [...history, lastMessage];
      const cachedContext = { tokens: 50, contextWindow: 1_000, percent: 5 };
      const remoteContext = { tokens: 60, contextWindow: 1_000, percent: 6 };
      const cachedDetail = task({ status: "idle", isStreaming: false, updatedAt, contextUsage: cachedContext, messages: [] });
      const remoteDetail = task({ status: "idle", isStreaming: false, updatedAt, contextUsage: remoteContext, messages: cachedMessages });
      mocks.getTaskBootstrap.mockReturnValue(bootstrap);
      mocks.getTask.mockReturnValue(bootstrap);
      mocks.getTaskDetail
        .mockResolvedValueOnce(cachedDetail)
        .mockResolvedValueOnce(remoteDetail);
      mocks.isTaskRuntimeOwnedElsewhere.mockReturnValue(true);
      mocks.subscribeTask.mockReturnValue(vi.fn());

      const response = await GET(
        new NextRequest(
          `http://127.0.0.1:3010/api/tasks/task-1/events?delta=1&cachedTaskUpdatedAt=${encodeURIComponent(updatedAt)}&cachedSessionId=session-1`,
        ),
        { params: Promise.resolve({ id: "task-1" }) },
      );
      const reader = response.body!.getReader();
      expect(eventData(await readChunk(reader)).eventType).toBe("bootstrap");
      expect(eventData(await readChunk(reader)).eventType).toBe("cache_ready");
      expect(eventData(await readChunk(reader))).toMatchObject({ eventType: "ready", messagesReused: true });

      // The first offline read fills the message baseline and sends only changed state, not history.
      await vi.advanceTimersByTimeAsync(2_000);
      const stateOnly = eventData(await readChunk(reader));
      expect(stateOnly).toMatchObject({
        eventType: "remote_poll", taskReused: true, messagesDelta: true, messages: [], contextUsage: remoteContext,
      });
      expect(stateOnly).not.toHaveProperty("task");
      mocks.getTaskDetail.mockResolvedValue(remoteDetail);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mocks.getTaskDetail).toHaveBeenCalledTimes(3);

      const changedMessage = {
        ...lastMessage,
        parts: [{ id: "p1", type: "text" as const, text: "new output" }],
      };
      mocks.getTaskDetail.mockResolvedValue({
        ...remoteDetail,
        updatedAt: "2026-01-01T00:00:01.000Z",
        messages: [...history, changedMessage],
      });
      await vi.advanceTimersByTimeAsync(4_000);
      const changed = eventData(await readChunk(reader));
      expect(changed.eventType).toBe("remote_poll");
      expect(changed.messagesDelta).toBe(true);
      expect(changed.messages).toEqual([changedMessage]);

      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reuse a matching cache while the task is working", async () => {
    const bootstrap = task({ messages: [], isStreaming: true });
    const detail = task({
      messages: [{ id: "history", role: "user", createdAt: 1, parts: [{ id: "part", type: "text", text: "履歴" }] }],
      isStreaming: true,
      status: "working",
    });
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockResolvedValue(detail);
    mocks.subscribeTask.mockReturnValue(vi.fn());

    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3010/api/tasks/task-1/events?cachedTaskUpdatedAt=2026-01-01T00%3A00%3A00.000Z&cachedSessionId=session-1",
      ),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    await readChunk(reader);

    const readyPayload = eventData(await readChunk(reader));
    expect(readyPayload.messagesReused).toBeUndefined();
    expect(readyPayload.messages).toEqual(detail.messages);
    expect(mocks.getTaskDetail).toHaveBeenNthCalledWith(1, "task-1", { includeMessages: false });
    expect(mocks.getTaskDetail).toHaveBeenNthCalledWith(2, "task-1");

    await reader.cancel();
  });

  it("returns opt-in getTaskDetail timings for perf diagnostics", async () => {
    const bootstrap = task({ messages: [], isStreaming: false, status: "idle" });
    const detail = task({ messages: [], isStreaming: false, status: "idle" });
    type TimingOptions = {
      onTiming?: (timing: { phase: string; durationMs: number }) => void;
    };
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockImplementation((_id: string, options?: TimingOptions) => {
      options?.onTiming?.({ phase: "ensureLive", durationMs: 1.2 });
      return Promise.resolve(detail);
    });
    mocks.subscribeTask.mockReturnValue(vi.fn());

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events?perf=1"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    await readChunk(reader);

    const readyPayload = eventData(await readChunk(reader));
    expect(readyPayload.serverTiming).toEqual([
      { phase: "ensureLive", durationMs: 1.2 },
    ]);

    await reader.cancel();
  });

  it("drops buffered snapshots older than the ready tip", async () => {
    const bootstrap = task({ messages: [], isStreaming: true });
    const detail = task({
      messages: [
        { id: "u1", role: "user", createdAt: 1, parts: [{ id: "p1", type: "text", text: "質問" }] },
        { id: "a1", role: "assistant", createdAt: 5, parts: [{ id: "p2", type: "text", text: "最新" }] },
      ],
      isStreaming: false,
      status: "idle",
    });
    let resolveDetail!: (value: TaskDetail) => void;
    let listener!: (payload: Record<string, unknown>) => void;
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockReturnValue(
      new Promise<TaskDetail>((resolve) => {
        resolveDetail = resolve;
      }),
    );
    mocks.subscribeTask.mockImplementation((_id: string, callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    });

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    await readChunk(reader);

    listener({
      type: "snapshot",
      task: task({ status: "working" }),
      messages: [{ id: "stale", role: "user", createdAt: 2, parts: [] }],
      eventType: "stale",
    });
    listener({
      type: "delta",
      message: { id: "ancient", role: "assistant", createdAt: 0, parts: [] },
    });
    resolveDetail(detail);

    const readyChunk = await readChunk(reader);
    expect(eventData(readyChunk).eventType).toBe("ready");

    const leftover = await Promise.race([
      readChunk(reader).then((chunk) => chunk),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    expect(leftover).toBeNull();
    await reader.cancel();
  });

  it("flushes a buffered permission request after ready even when messages match", async () => {
    const messages = [
      { id: "u1", role: "user" as const, createdAt: 1, parts: [{ id: "p1", type: "text" as const, text: "質問" }] },
    ];
    const bootstrap = task({ messages: [], isStreaming: true });
    const detail = task({ messages, isStreaming: true, status: "working" });
    let resolveDetail!: (value: TaskDetail) => void;
    let listener!: (payload: Record<string, unknown>) => void;
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockReturnValue(
      new Promise<TaskDetail>((resolve) => {
        resolveDetail = resolve;
      }),
    );
    mocks.subscribeTask.mockImplementation((_id: string, callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    });

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    await readChunk(reader);

    listener({
      type: "snapshot",
      eventType: "permission_request",
      messages,
      permissionRequest: {
        id: "req-1",
        sessionId: "session-1",
        command: "Stop-Computer",
        labels: ["os"],
        message: "許可しますか",
      },
    });
    resolveDetail(detail);

    const readyChunk = await readChunk(reader);
    expect(eventData(readyChunk).eventType).toBe("ready");
    const permissionChunk = await readChunk(reader);
    const permissionPayload = eventData(permissionChunk);
    expect(permissionPayload.eventType).toBe("permission_request");
    expect(permissionPayload.permissionRequest).toMatchObject({ id: "req-1" });
    await reader.cancel();
  });

  it("puts pending attention and abort state on the bootstrap snapshot", async () => {
    mocks.getTaskBootstrap.mockReturnValue(
      task({
        messages: [],
        isStreaming: true,
        manualAbortedAssistantId: "",
        hangRetryCount: 2,
        revertLeafId: "leaf-tip",
      }),
    );
    mocks.pendingPermissionForTask.mockReturnValue({
      id: "req-1",
      sessionId: "sess-1",
      message: "許可しますか",
      command: "echo hi",
      labels: [],
    });
    mocks.pendingQuestionForTask.mockReturnValue({
      id: "q-1",
      sessionId: "sess-1",
      questions: [{ question: "どれですか", options: [] }],
    });
    mocks.getTaskDetail.mockReturnValue(new Promise<TaskDetail>(() => undefined));
    mocks.subscribeTask.mockReturnValue(vi.fn());

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    const bootstrapPayload = eventData(await readChunk(reader));
    expect(bootstrapPayload.eventType).toBe("bootstrap");
    expect(bootstrapPayload.permissionRequest).toMatchObject({ id: "req-1" });
    expect(bootstrapPayload.questionRequest).toMatchObject({ id: "q-1" });
    expect(bootstrapPayload.manualAbortedAssistantId).toBe("");
    expect(bootstrapPayload.hangRetryCount).toBe(2);
    expect(bootstrapPayload.revertLeafId).toBe("leaf-tip");
    await reader.cancel();
  });

  it("falls back to offline ready when getTaskDetail hangs past the timeout", async () => {
    vi.useFakeTimers();
    const bootstrap = task({ messages: [], isStreaming: false, status: "idle" });
    const offline = task({
      messages: [
        { id: "u1", role: "user", createdAt: 1, parts: [{ id: "p1", type: "text", text: "hi" }] },
      ],
      isStreaming: false,
      status: "idle",
    });
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail
      .mockReturnValueOnce(new Promise<TaskDetail>(() => undefined))
      .mockResolvedValueOnce(offline);
    mocks.subscribeTask.mockReturnValue(vi.fn());

    try {
      const response = await GET(
        new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
        { params: Promise.resolve({ id: "task-1" }) },
      );
      const reader = response.body!.getReader();
      expect(eventData(await readChunk(reader)).eventType).toBe("bootstrap");
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      let readyPayload: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const chunk = await readChunk(reader);
        if (!chunk.includes("data: ")) continue;
        const payload = eventData(chunk);
        if (payload.eventType === "ready") {
          readyPayload = payload;
          break;
        }
      }
      expect(readyPayload?.eventType).toBe("ready");
      expect(mocks.getTaskDetail).toHaveBeenLastCalledWith("task-1", { offline: true });
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts abort and hang retry state on the ready snapshot", async () => {
    const messages = [
      { id: "u1", role: "user" as const, createdAt: 1, parts: [{ id: "p1", type: "text" as const, text: "質問" }] },
    ];
    const bootstrap = task({ messages: [], isStreaming: true });
    const detail = task({
      messages,
      isStreaming: false,
      status: "idle",
      manualAbortedAssistantId: "",
      hangRetryCount: 2,
      revertLeafId: "leaf-tip",
    });
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockResolvedValue(detail);
    mocks.subscribeTask.mockReturnValue(vi.fn());

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    await readChunk(reader);
    const readyChunk = await readChunk(reader);
    const readyPayload = eventData(readyChunk);
    expect(readyPayload.eventType).toBe("ready");
    expect(readyPayload.manualAbortedAssistantId).toBe("");
    expect(readyPayload.hangRetryCount).toBe(2);
    expect(readyPayload.revertLeafId).toBe("leaf-tip");
    expect(readyPayload.task).toMatchObject({ revertLeafId: "leaf-tip" });
    expect(readyPayload.task).not.toHaveProperty("manualAbortedAssistantId");
    expect(readyPayload.task).not.toHaveProperty("hangRetryCount");
    await reader.cancel();
  });

  it("keeps a buffered permission request when a later history snapshot arrives", async () => {
    const messages = [
      { id: "u1", role: "user" as const, createdAt: 1, parts: [{ id: "p1", type: "text" as const, text: "質問" }] },
    ];
    const bootstrap = task({ messages: [], isStreaming: true });
    const detail = task({ messages, isStreaming: true, status: "working" });
    let resolveDetail!: (value: TaskDetail) => void;
    let listener!: (payload: Record<string, unknown>) => void;
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockReturnValue(
      new Promise<TaskDetail>((resolve) => {
        resolveDetail = resolve;
      }),
    );
    mocks.subscribeTask.mockImplementation((_id: string, callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    });

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    await readChunk(reader);

    listener({
      type: "snapshot",
      eventType: "permission_request",
      messages,
      permissionRequest: {
        id: "req-1",
        sessionId: "session-1",
        command: "Stop-Computer",
        labels: ["os"],
        message: "許可しますか",
      },
    });
    listener({
      type: "snapshot",
      eventType: "intermediate",
      messages: [
        ...messages,
        { id: "a1", role: "assistant", createdAt: 2, parts: [] },
      ],
    });
    resolveDetail(detail);

    const readyChunk = await readChunk(reader);
    expect(eventData(readyChunk).eventType).toBe("ready");
    const permissionChunk = await readChunk(reader);
    expect(eventData(permissionChunk).eventType).toBe("permission_request");
    const intermediateChunk = await readChunk(reader);
    expect(eventData(intermediateChunk).eventType).toBe("intermediate");
    await reader.cancel();
  });

  it("cancels a buffered permission request when resolved arrives before ready", async () => {
    const messages = [
      { id: "u1", role: "user" as const, createdAt: 1, parts: [{ id: "p1", type: "text" as const, text: "質問" }] },
    ];
    const bootstrap = task({ messages: [], isStreaming: true });
    const detail = task({ messages, isStreaming: true, status: "working" });
    let resolveDetail!: (value: TaskDetail) => void;
    let listener!: (payload: Record<string, unknown>) => void;
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockReturnValue(
      new Promise<TaskDetail>((resolve) => {
        resolveDetail = resolve;
      }),
    );
    mocks.subscribeTask.mockImplementation((_id: string, callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    });

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    await readChunk(reader);

    listener({
      type: "snapshot",
      eventType: "permission_request",
      messages,
      permissionRequest: {
        id: "req-1",
        sessionId: "session-1",
        command: "Stop-Computer",
        labels: ["os"],
        message: "許可しますか",
      },
    });
    listener({
      type: "snapshot",
      eventType: "permission_resolved",
      messages,
      permissionRequest: null,
    });
    listener({
      type: "snapshot",
      eventType: "intermediate",
      messages: [
        ...messages,
        { id: "a1", role: "assistant", createdAt: 2, parts: [] },
      ],
    });
    resolveDetail(detail);

    const readyChunk = await readChunk(reader);
    expect(eventData(readyChunk).eventType).toBe("ready");
    const intermediateChunk = await readChunk(reader);
    expect(eventData(intermediateChunk).eventType).toBe("intermediate");

    // Next live event proves no ghost permission_* was queued ahead of it.
    listener({
      type: "snapshot",
      eventType: "hang_retry",
      hangRetryCount: 1,
      messages,
    });
    const hangChunk = await readChunk(reader);
    expect(eventData(hangChunk).eventType).toBe("hang_retry");
    await reader.cancel();
  });

  it("uses live pending on ready even when detail still has a resolved request", async () => {
    const messages = [
      { id: "u1", role: "user" as const, createdAt: 1, parts: [{ id: "p1", type: "text" as const, text: "質問" }] },
    ];
    const stalePermission = {
      id: "req-stale",
      sessionId: "session-1",
      command: "Stop-Computer",
      labels: ["os"],
      message: "許可しますか",
    };
    const bootstrap = task({ messages: [], isStreaming: true });
    const detail = task({
      messages,
      isStreaming: true,
      status: "working",
      permissionRequest: stalePermission,
    });
    let resolveDetail!: (value: TaskDetail) => void;
    let listener!: (payload: Record<string, unknown>) => void;
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockReturnValue(
      new Promise<TaskDetail>((resolve) => {
        resolveDetail = resolve;
      }),
    );
    mocks.subscribeTask.mockImplementation((_id: string, callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    });
    mocks.pendingPermissionForTask.mockReturnValue(stalePermission);

    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/tasks/task-1/events"),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const reader = response.body!.getReader();
    await readChunk(reader);

    listener({
      type: "snapshot",
      eventType: "permission_request",
      messages,
      permissionRequest: stalePermission,
    });
    // User answered while detail was still loading — live pending cleared,
    // buffered request+resolved cancel out.
    mocks.pendingPermissionForTask.mockReturnValue(null);
    listener({
      type: "snapshot",
      eventType: "permission_resolved",
      messages,
      permissionRequest: null,
    });
    resolveDetail(detail);

    const readyChunk = await readChunk(reader);
    const readyPayload = eventData(readyChunk);
    expect(readyPayload.eventType).toBe("ready");
    expect(readyPayload.permissionRequest).toBeNull();

    // No ghost permission_* after ready — next live event is first.
    listener({
      type: "snapshot",
      eventType: "hang_retry",
      hangRetryCount: 1,
      messages,
    });
    const hangChunk = await readChunk(reader);
    expect(eventData(hangChunk).eventType).toBe("hang_retry");
    await reader.cancel();
  });
});
