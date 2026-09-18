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
vi.mock("@/lib/bot-intercom", () => ({
  getBotIntercomInbox: () => ({ messages: [], unreadCount: 0, preview: null, pendingAsks: [] }),
  subscribeBotIntercomInbox: () => () => undefined,
}));
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
  it("sends a bootstrap snapshot first, then the latest page for the same task", async () => {
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
    // 再接続しても、切断中に積まれた最新ページは ready スナップショットが運ぶ。
    expect(events[1]).toMatchObject({ event: "snapshot" });
    expect(events[1].data).toMatchObject({ eventType: "ready", isStreaming: false, permissionRequest: permission });
    expect((events[1].data.messages as UiMessage[]).map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("bot:one", { offline: true });
    expect(mocks.lastTaskId).toBe("bot:one");
  });

  it("reuses a matching idle cache before the full detail projection finishes", async () => {
    const bootstrap = {
      id: "bot:one",
      status: "idle",
      updatedAt: "revision-1",
      sessionId: "session-1",
      messages: [],
      isStreaming: false,
      isCompacting: false,
    };
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail.mockResolvedValue({
      ...bootstrap,
      messages: [message("cached", "キャッシュ済み")],
    });

    const response = await GET(
      new NextRequest("http://localhost/api/bots/one/events?cachedTaskUpdatedAt=revision-1&cachedSessionId=session-1"),
      params,
    );
    const events = await readEvents(response, 3);

    expect(events.map((event) => event.data.eventType)).toEqual(["bootstrap", "cache_ready", "ready"]);
    expect(events[1]?.data.messagesReused).toBe(true);
    expect(events[2]?.data.messagesReused).toBe(true);
    expect(events[2]?.data.messages).toBeUndefined();
    expect(mocks.getTaskDetail).toHaveBeenCalledWith("bot:one", { includeMessages: false });
  });

  it("refreshes a stale cache with a full ready page", async () => {
    const bootstrap = {
      id: "bot:one",
      status: "idle",
      updatedAt: "revision-2",
      sessionId: "session-2",
      messages: [],
      isStreaming: false,
      isCompacting: false,
    };
    mocks.getTaskBootstrap.mockReturnValue(bootstrap);
    mocks.getTaskDetail
      .mockResolvedValueOnce({ ...bootstrap, messages: [] })
      .mockResolvedValueOnce({ ...bootstrap, messages: [message("latest", "最新履歴")] });

    const response = await GET(
      new NextRequest("http://localhost/api/bots/one/events?cachedTaskUpdatedAt=revision-1&cachedSessionId=session-1"),
      params,
    );
    const events = await readEvents(response);

    expect(events.map((event) => event.data.eventType)).toEqual(["bootstrap", "ready"]);
    expect(events[1]?.data.historyReset).toBe(true);
    expect((events[1]?.data.messages as UiMessage[]).map((item) => item.id)).toEqual(["latest"]);
    expect(mocks.getTaskDetail).toHaveBeenNthCalledWith(1, "bot:one", { includeMessages: false });
    expect(mocks.getTaskDetail).toHaveBeenNthCalledWith(2, "bot:one");
  });

  it("buffers a rewind event until the ready page is sent", async () => {
    mocks.getTaskBootstrap.mockReturnValue({ id: "bot:one", status: "idle", messages: [], isStreaming: false });
    let resolveDetail!: (value: unknown) => void;
    mocks.getTaskDetail.mockReturnValue(new Promise((resolve) => {
      resolveDetail = resolve;
    }));
    const response = await GET(request(), params);
    mocks.listener?.({
      type: "snapshot",
      eventType: "revert",
      messages: [message("new", "新しい履歴")],
      historyReset: true,
    });
    resolveDetail({ id: "bot:one", status: "idle", messages: [message("old", "古い履歴")], isStreaming: false, isCompacting: false });

    const events = await readEvents(response, 3);
    expect(events.map((event) => event.data.eventType)).toEqual(["bootstrap", "ready", "revert"]);
    expect(events[2]?.data.historyReset).toBe(true);
    expect((events[2]?.data.messages as UiMessage[]).map((item) => item.id)).toEqual(["new"]);
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

  it("falls back to offline ready when live getTaskDetail fails", async () => {
    mocks.getTaskBootstrap.mockReturnValue({ id: "bot:one", status: "idle", messages: [], isStreaming: false });
    mocks.getTaskDetail
      .mockRejectedValueOnce(Object.assign(new Error("モデルを利用できません: leafcodecloud::LeafModel"), { status: 503 }))
      .mockResolvedValueOnce({
        id: "bot:one",
        status: "idle",
        messages: [message("kept", "残る履歴")],
        isStreaming: false,
        isCompacting: false,
      });

    const response = await GET(request(), params);
    const events = await readEvents(response);

    expect(events).toHaveLength(2);
    expect(events[0]?.data.eventType).toBe("bootstrap");
    expect(events[1]).toMatchObject({
      event: "snapshot",
      data: {
        eventType: "ready",
        error: "モデルを利用できません: leafcodecloud::LeafModel",
      },
    });
    expect((events[1]?.data.messages as UiMessage[]).map((item) => item.id)).toEqual(["kept"]);
    expect(mocks.getTaskDetail).toHaveBeenLastCalledWith("bot:one", { offline: true });
  });

  it("falls back to offline ready when getTaskDetail hangs past the timeout", async () => {
    vi.useFakeTimers();
    mocks.getTaskBootstrap.mockReturnValue({ id: "bot:one", status: "idle", messages: [], isStreaming: false });
    mocks.getTaskDetail
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce({
        id: "bot:one",
        status: "idle",
        messages: [message("offline", "オフライン")],
        isStreaming: false,
        isCompacting: false,
      });
    try {
      const response = await GET(request(), params);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const events: Array<Record<string, unknown>> = [];
      const collect = async () => {
        while (events.length < 2) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
            if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
            index = buffer.indexOf("\n\n");
          }
        }
      };
      const collectPromise = collect();
      await vi.advanceTimersByTimeAsync(30_000);
      await collectPromise;
      expect(events[0]?.eventType).toBe("bootstrap");
      expect(events[1]?.eventType).toBe("ready");
      expect(mocks.getTaskDetail).toHaveBeenLastCalledWith("bot:one", { offline: true });
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
