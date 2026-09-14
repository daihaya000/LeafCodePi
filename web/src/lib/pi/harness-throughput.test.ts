import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { trackThroughputEvent } from "./harness";

function liveState() {
  const persisted: unknown[][] = [];
  return {
    live: {
      throughputByStartedAt: new Map(),
      persistedThroughputKeys: new Set(),
      toolStartedAt: new Map(),
      toolEndedAt: new Map(),
      toolPartialOutputByCallId: new Map(),
      session: {
        sessionManager: {
          appendCustomEntry: (...args: unknown[]) => persisted.push(args),
        },
      },
    } as unknown as Parameters<typeof trackThroughputEvent>[0],
    persisted,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("trackThroughputEvent", () => {
  it("finalizes and persists an assistant timing on message_end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { live, persisted } = liveState();

    trackThroughputEvent(live, {
      type: "message_start",
      message: { role: "assistant", timestamp: 1_000 },
    });
    vi.setSystemTime(1_100);
    trackThroughputEvent(live, {
      type: "message_update",
      message: { role: "assistant", timestamp: 1_000, usage: { output: 2 } },
      assistantMessageEvent: { type: "text_delta", delta: "ok" },
    });
    trackThroughputEvent(live, {
      type: "message_end",
      message: { role: "assistant", timestamp: 1_000, usage: { output: 2 } },
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.[0], "leafcode-pi.throughput");
    assert.equal((persisted[0]?.[1] as { outputTokens?: number }).outputTokens, 2);
  });

  it("accepts the legacy tool id field and clears partial output at tool end", () => {
    const { live } = liveState();

    trackThroughputEvent(live, {
      type: "tool_execution_update",
      toolCallID: "call-1",
      partialResult: "in progress",
    });
    assert.equal(live.toolPartialOutputByCallId.get("call-1"), "in progress");

    trackThroughputEvent(live, {
      type: "message_end",
      message: { role: "toolResult", toolCallId: "call-1" },
    });
    assert.equal(live.toolPartialOutputByCallId.has("call-1"), false);
  });
});
