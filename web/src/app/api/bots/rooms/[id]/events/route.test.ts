import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomDto } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getRoom: vi.fn(),
  subscribeRoom: vi.fn(() => () => undefined),
  subscribeTask: vi.fn(() => () => undefined),
  linkedCodeTaskIdsForOrigin: vi.fn((): string[] => []),
  pendingPermissionForTask: vi.fn((): unknown => null),
  pendingQuestionForTask: vi.fn<(taskId: string) => unknown>(() => null),
  localRuntimeBlocked: vi.fn(() => false),
  forwardPendingRequestsByTask: vi.fn(),
  subscribeBackendTaskDirty: vi.fn(() => () => undefined),
}));

vi.mock("@/lib/rooms", () => ({
  getRoom: mocks.getRoom,
  roomBotTaskId: (roomId: string, botId: string) => `bot:${botId}:room:${roomId}`,
  subscribeRoom: mocks.subscribeRoom,
}));
vi.mock("@/lib/pi/harness", () => ({
  linkedCodeTaskIdsForOrigin: mocks.linkedCodeTaskIdsForOrigin,
  pendingPermissionForTask: mocks.pendingPermissionForTask,
  pendingQuestionForTask: mocks.pendingQuestionForTask,
  subscribeTask: mocks.subscribeTask,
}));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({
  forwardPendingRequestsByTask: mocks.forwardPendingRequestsByTask,
}));
vi.mock("@/lib/backend-task-dirty-hub", () => ({
  subscribeBackendTaskDirty: mocks.subscribeBackendTaskDirty,
}));

import { GET } from "./route";

const room = (overrides: Partial<RoomDto> = {}): RoomDto => ({
  id: "r1",
  name: "Room",
  members: ["one", "two"],
  botRelayEnabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messages: [],
  ...overrides,
});

const request = () => new NextRequest("http://localhost/api/bots/rooms/r1/events");
const params = { params: Promise.resolve({ id: "r1" }) };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Reads until one complete SSE block arrives, then returns it. */
async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ event: string; data: Record<string, unknown> }> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const index = buffer.indexOf("\n\n");
    if (index < 0) continue;
    const lines = buffer.slice(0, index).split("\n");
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));
    if (eventLine && dataLine) {
      return { event: eventLine.slice(7).trim(), data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> };
    }
    buffer = buffer.slice(index + 2);
  }
  throw new Error("no SSE event arrived");
}

describe("GET /api/bots/rooms/[id]/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRoom.mockReturnValue(room());
    mocks.subscribeRoom.mockReturnValue(() => undefined);
    mocks.subscribeTask.mockReturnValue(() => undefined);
    mocks.linkedCodeTaskIdsForOrigin.mockReturnValue([]);
    mocks.pendingPermissionForTask.mockReturnValue(null);
    mocks.pendingQuestionForTask.mockReturnValue(null);
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.forwardPendingRequestsByTask.mockResolvedValue({ ok: true, byTask: {} });
    mocks.subscribeBackendTaskDirty.mockReturnValue(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads pending attention from the owning Backend, never from this process", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardPendingRequestsByTask.mockResolvedValue({
      ok: true,
      byTask: {
        "bot:one:room:r1": { permissionRequest: { id: "p1" }, questionRequest: null },
      },
    });
    const response = await GET(request(), params);
    const reader = response.body!.getReader();
    const first = await readEvent(reader);
    expect(first.event).toBe("snapshot");
    expect(first.data.attention).toEqual([
      { botId: "one", taskId: "bot:one:room:r1", permission: { id: "p1" }, question: null },
    ]);
    // The owner's map is the only source after the cutover.
    expect(mocks.pendingPermissionForTask).not.toHaveBeenCalled();
    expect(mocks.pendingQuestionForTask).not.toHaveBeenCalled();
    expect(mocks.forwardPendingRequestsByTask).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeBackendTaskDirty).toHaveBeenCalled();
    // Cutover Room streams wake via dirty + disk poll; local task emitters are empty.
    expect(mocks.subscribeTask).not.toHaveBeenCalled();
    await reader.cancel();
  });

  it("keeps local reads for the owning process", async () => {
    mocks.pendingQuestionForTask.mockImplementation((taskId: string) => (
      taskId === "bot:two:room:r1" ? { id: "q2" } : null
    ));
    const response = await GET(request(), params);
    const reader = response.body!.getReader();
    const first = await readEvent(reader);
    expect(first.data.attention).toEqual([
      { botId: "two", taskId: "bot:two:room:r1", permission: null, question: { id: "q2" } },
    ]);
    expect(mocks.forwardPendingRequestsByTask).not.toHaveBeenCalled();
    expect(mocks.subscribeBackendTaskDirty).not.toHaveBeenCalled();
    expect(mocks.subscribeTask).toHaveBeenCalled();
    await reader.cancel();
  });

  it("serializes polls and clears attention once the owner answers", async () => {
    vi.useFakeTimers();
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardPendingRequestsByTask.mockResolvedValue({
      ok: true,
      byTask: {
        "bot:one:room:r1": { permissionRequest: { id: "p1" }, questionRequest: { id: "q1" } },
      },
    });
    const response = await GET(request(), params);
    const reader = response.body!.getReader();
    expect((await readEvent(reader)).data.attention).toHaveLength(1);
    // A slow owner read holds the poll: the next tick must not start a second read.
    const slow = deferred<{ ok: true; byTask: Record<string, never> }>();
    mocks.forwardPendingRequestsByTask.mockReturnValue(slow.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.forwardPendingRequestsByTask).toHaveBeenCalledTimes(2);
    slow.resolve({ ok: true, byTask: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect((await readEvent(reader)).data.attention).toEqual([]);
    await reader.cancel();
  });

  it("keeps the last attention map when a soft-failed owner read returns ok:false", async () => {
    vi.useFakeTimers();
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardPendingRequestsByTask.mockResolvedValueOnce({
      ok: true,
      byTask: {
        "bot:one:room:r1": { permissionRequest: { id: "p1" }, questionRequest: null },
      },
    });
    const response = await GET(request(), params);
    const reader = response.body!.getReader();
    expect((await readEvent(reader)).data.attention).toEqual([
      { botId: "one", taskId: "bot:one:room:r1", permission: { id: "p1" }, question: null },
    ]);
    mocks.forwardPendingRequestsByTask.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    await vi.advanceTimersByTimeAsync(5_000);
    // Soft-fail must not clear attention; signature stays the same so no new snapshot is required.
    expect(mocks.forwardPendingRequestsByTask).toHaveBeenCalledTimes(2);
    mocks.forwardPendingRequestsByTask.mockResolvedValueOnce({
      ok: true,
      byTask: {
        "bot:two:room:r1": { permissionRequest: { id: "p2" }, questionRequest: null },
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await readEvent(reader)).data.attention).toEqual([
      { botId: "two", taskId: "bot:two:room:r1", permission: { id: "p2" }, question: null },
    ]);
    await reader.cancel();
  });

  it("keeps polling after a failed owner read instead of freezing the stream", async () => {
    vi.useFakeTimers();
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardPendingRequestsByTask.mockRejectedValueOnce(new Error("read failed"));
    const response = await GET(request(), params);
    const reader = response.body!.getReader();
    expect((await readEvent(reader)).data.attention).toEqual([]);
    mocks.forwardPendingRequestsByTask.mockResolvedValue({
      ok: true,
      byTask: {
        "bot:two:room:r1": { permissionRequest: { id: "p2" }, questionRequest: null },
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await readEvent(reader)).data.attention).toEqual([
      { botId: "two", taskId: "bot:two:room:r1", permission: { id: "p2" }, question: null },
    ]);
    await reader.cancel();
  });

  it("returns 404 for an unknown room", async () => {
    mocks.getRoom.mockReturnValue(undefined);
    const response = await GET(request(), params);
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});
