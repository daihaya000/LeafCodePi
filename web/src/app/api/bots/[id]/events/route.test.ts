import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  lastTaskId: "",
  listener: undefined as ((payload: Record<string, unknown>) => void) | undefined,
  subscribeTask: vi.fn((taskId: string, listener: (payload: Record<string, unknown>) => void) => {
    mocks.lastTaskId = taskId;
    mocks.listener = listener;
    return () => undefined;
  }),
  getTaskBootstrap: vi.fn(),
  getTaskDetail: vi.fn(),
  pendingPermissionForTask: vi.fn((): unknown => null),
  pendingQuestionForTask: vi.fn((): unknown => null),
}));

vi.mock("@/lib/bots", () => ({ botTaskId: (id: string) => `bot:${id}` }));
vi.mock("@/lib/pi/harness", () => ({
  subscribeTask: mocks.subscribeTask,
  getTaskBootstrap: mocks.getTaskBootstrap,
  getTaskDetail: mocks.getTaskDetail,
  pendingPermissionForTask: mocks.pendingPermissionForTask,
  pendingQuestionForTask: mocks.pendingQuestionForTask,
}));

import { GET } from "./route";

function message(id: string, text: string): UiMessage {
  return { id, role: "assistant", createdAt: 2, parts: [{ id: `${id}-text`, type: "text", text }] };
}

/** Read the first `count` SSE blocks, then cancel so the heartbeat does not outlive the test. */
async function readEvents(response: Response, count = 2): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let buffer = "";
  const deadline = Date.now() + 3_000;
  try {
    while (events.length < count && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const lines = buffer.slice(0, index).split("\n");
        buffer = buffer.slice(index + 2);
        const eventLine = lines.find((line) => line.startsWith("event: "));
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (eventLine && dataLine) events.push({ event: eventLine.slice(7).trim(), data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> });
        index = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

const request = () => new NextRequest("http://localhost/api/bots/one/events");
const params = { params: Promise.resolve({ id: "one" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lastTaskId = "";
  mocks.listener = undefined;
  mocks.pendingPermissionForTask.mockReturnValue(null);
  mocks.pendingQuestionForTask.mockReturnValue(null);
});

describe("GET /api/bots/[id]/events", () => {
  it("sends a bootstrap snapshot first, then the full detail for the same task", async () => {
    mocks.getTaskBootstrap.mockReturnValue({ id: "bot:one", status: "idle", messages: [], isStreaming: false });
    mocks.getTaskDetail.mockResolvedValue({
      id: "bot:one",
      status: "idle",
      messages: [message("m1", "こんにちは"), message("m2", "RECONNECT-1")],
      isStreaming: false,
      isCompacting: false,
    });
    const permission = { id: "permission-1", command: "code_session", message: "Codeへ依頼します", labels: [] };
    mocks.pendingPermissionForTask.mockReturnValue(permission);

    const response = await GET(request(), params);
    const events = await readEvents(response);

    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "snapshot" });
    expect(events[0].data).toMatchObject({ eventType: "bootstrap", messages: [] });
    // 再接続しても、切断中に積まれた会話は ready スナップショットが丸ごと運ぶ。
    expect(events[1]).toMatchObject({ event: "snapshot" });
    expect(events[1].data).toMatchObject({ eventType: "ready", isStreaming: false, permissionRequest: permission });
    expect((events[1].data.messages as UiMessage[]).map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(mocks.lastTaskId).toBe("bot:one");
  });

  it("streams task events after the snapshots and stays safe once the client disconnects", async () => {
    mocks.getTaskBootstrap.mockReturnValue({ id: "bot:one", status: "idle", messages: [], isStreaming: false });
    mocks.getTaskDetail.mockResolvedValue({ id: "bot:one", status: "idle", messages: [], isStreaming: false, isCompacting: false });
    const response = await GET(request(), params);
    await readEvents(response);

    // デルタは delta として、それ以外は snapshot として流れる（購読解除後でも例外を投げない）。
    expect(mocks.listener).toBeTypeOf("function");
    expect(() => mocks.listener?.({ type: "delta", message: message("m3", "途中") })).not.toThrow();
  });
});
