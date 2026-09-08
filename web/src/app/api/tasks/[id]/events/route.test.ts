import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@/lib/types";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  getTaskBootstrap: vi.fn(),
  getTaskDetail: vi.fn(),
  pendingPermissionForTask: vi.fn(),
  pendingQuestionForTask: vi.fn(),
  subscribeTask: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);

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
    mocks.getTaskBootstrap.mockReset();
    mocks.getTaskDetail.mockReset();
    mocks.pendingPermissionForTask.mockReset().mockReturnValue(null);
    mocks.pendingQuestionForTask.mockReset().mockReturnValue(null);
    mocks.subscribeTask.mockReset();
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
    listener({
      type: "snapshot",
      task: task({ status: "working" }),
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
    expect(eventData(pendingSnapshotChunk).eventType).toBe("intermediate");
    const deltaChunk = await readChunk(reader);
    expect(deltaChunk).toContain("event: delta\n");
    const deltaPayload = eventData(deltaChunk);
    expect(deltaPayload.type).toBe("delta");
    expect(deltaPayload.message).toMatchObject({ id: "live-latest", role: "assistant" });
    expect(deltaPayload).not.toHaveProperty("messages");
    expect(deltaPayload).not.toHaveProperty("task");

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

    const readyPayload = eventData(await readChunk(reader));
    expect(readyPayload.eventType).toBe("ready");
    expect(readyPayload.messagesReused).toBe(true);
    expect(readyPayload).not.toHaveProperty("messages");
    expect(mocks.getTaskDetail).toHaveBeenCalledOnce();
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("task-1", { includeMessages: false });

    await reader.cancel();
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
