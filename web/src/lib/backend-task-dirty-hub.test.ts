import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetBackendTaskDirtyHubForTests,
  subscribeBackendTaskDirty,
} from "./backend-task-dirty-hub";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "@shared/backend-protocol.mjs";

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index++]));
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
      },
    },
  );
}

describe("backend-task-dirty-hub", () => {
  beforeEach(() => {
    resetBackendTaskDirtyHubForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    resetBackendTaskDirtyHubForTests();
    vi.useRealTimers();
  });

  it("notifies only listeners for the dirty task id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      ": connected\n\n",
      "event: task_dirty\ndata: {\"taskId\":\"task-1\",\"reason\":\"abort\"}\n\n",
      "event: snapshot\ndata: {\"eventType\":\"code_session_changed\"}\n\n",
      "event: task_dirty\ndata: {\"taskId\":\"task-2\"}\n\n",
    ]));
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeBackendTaskDirty("task-1", first, {
      env: { LEAFCODE_PI_BACKEND_TOKEN: "token", LEAFCODE_PI_BACKEND_PORT: "18776" },
      fetchImpl,
    });
    const stopSecond = subscribeBackendTaskDirty("task-2", second, {
      env: { LEAFCODE_PI_BACKEND_TOKEN: "token", LEAFCODE_PI_BACKEND_PORT: "18776" },
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(first).toHaveBeenCalledWith({ taskId: "task-1", reason: "abort" });
    expect(second).toHaveBeenCalledWith({ taskId: "task-2" });
    expect(first).toHaveBeenCalledTimes(1);
    stopFirst();
    stopSecond();
  });
});
