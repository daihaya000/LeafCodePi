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
      type: "delta",
      task: task({ status: "working" }),
      message: { id: "live-latest", role: "assistant", createdAt: 3, parts: [] },
    });
    resolveDetail(detail);

    const readyChunk = await readChunk(reader);
    expect(eventData(readyChunk).eventType).toBe("ready");
    const deltaChunk = await readChunk(reader);
    expect(deltaChunk).toContain("event: delta\n");
    const deltaPayload = eventData(deltaChunk);
    expect(deltaPayload.type).toBe("delta");
    expect(deltaPayload.message).toMatchObject({ id: "live-latest", role: "assistant" });
    expect(deltaPayload).not.toHaveProperty("messages");

    await reader.cancel();
  });
});
