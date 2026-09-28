import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { snapshotThroughput } from "@/lib/token-throughput";
import { trackThroughputEvent } from "./harness";
import { VersionedThroughputMap } from "./versioned-throughput-map";

function liveState() {
  const persisted: unknown[][] = [];
  return {
    live: {
      throughputByStartedAt: new VersionedThroughputMap(),
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
    const timings = live.throughputByStartedAt;
    assert.ok(timings instanceof VersionedThroughputMap);
    assert.equal(timings.revision, 1);
    assert.equal(timings.awaitingFirstTokenCount, 1);
    vi.setSystemTime(1_100);
    trackThroughputEvent(live, {
      type: "message_update",
      message: { role: "assistant", timestamp: 1_000, usage: { output: 2 } },
      assistantMessageEvent: { type: "text_delta", delta: "ok" },
    });
    assert.equal(timings.revision, 2);
    assert.equal(timings.awaitingFirstTokenCount, 0);
    trackThroughputEvent(live, {
      type: "message_end",
      message: { role: "assistant", timestamp: 1_000, usage: { output: 2 } },
    });
    assert.equal(timings.revision, 3);
    assert.equal(timings.awaitingFirstTokenCount, 0);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.[0], "leafcode-pi.throughput");
    assert.equal((persisted[0]?.[1] as { outputTokens?: number }).outputTokens, 2);
  });

  it("keeps the streamed estimate when an aborted stream only has a placeholder usage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { live, persisted } = liveState();
    const update = (delta: string) => trackThroughputEvent(live, {
      type: "message_update",
      message: { role: "assistant", timestamp: 1_000, usage: { output: 6 } },
      assistantMessageEvent: { type: "thinking_delta", delta },
    });

    trackThroughputEvent(live, {
      type: "message_start",
      message: { role: "assistant", timestamp: 1_000 },
    });
    vi.setSystemTime(2_000);
    update("a".repeat(400));
    vi.setSystemTime(4_000);
    update("b".repeat(400));
    // Mid-stream, message_start's 6 tokens are not the output so far.
    assert.equal(snapshotThroughput(live.throughputByStartedAt.get(1_000)!)?.outputTokens, 200);

    trackThroughputEvent(live, {
      type: "message_end",
      message: { role: "assistant", timestamp: 1_000, stopReason: "aborted", usage: { output: 6 } },
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.equal((persisted[0]?.[1] as { outputTokens?: number }).outputTokens, 200);
    assert.equal(snapshotThroughput(live.throughputByStartedAt.get(1_000)!)?.outputTokens, 200);
  });

  it("keeps partial outputs through execution_end and removes each on toolResult", () => {
    const { live } = liveState();

    trackThroughputEvent(live, {
      type: "tool_execution_update",
      toolCallID: "call-1",
      partialResult: "in progress",
    });
    trackThroughputEvent(live, {
      type: "tool_execution_update",
      toolCallId: "call-2",
      partialResult: "other progress",
    });
    assert.equal(live.toolPartialOutputByCallId.size, 2);

    trackThroughputEvent(live, {
      type: "tool_execution_end", toolCallId: "call-1", result: "final",
    });
    assert.equal(live.toolPartialOutputByCallId.get("call-1"), "final");
    assert.equal(live.toolPartialOutputByCallId.size, 2);

    trackThroughputEvent(live, {
      type: "message_end",
      message: { role: "toolResult", toolCallId: "call-1" },
    });
    assert.equal(live.toolPartialOutputByCallId.has("call-1"), false);
    assert.equal(live.toolPartialOutputByCallId.get("call-2"), "other progress");
    trackThroughputEvent(live, {
      type: "message_end",
      message: { role: "toolResult", toolCallId: "call-2" },
    });
    assert.equal(live.toolPartialOutputByCallId.size, 0);
  });

  it("retains tool timing after toolResult and updates reused call IDs in place", () => {
    vi.useFakeTimers();
    const { live } = liveState();

    vi.setSystemTime(1_000);
    trackThroughputEvent(live, { type: "tool_execution_start", toolCallId: "call-1" });
    vi.setSystemTime(1_600);
    trackThroughputEvent(live, { type: "tool_execution_end", toolCallId: "call-1", result: "done" });
    trackThroughputEvent(live, {
      type: "message_end", message: { role: "toolResult", toolCallId: "call-1" },
    });
    assert.deepEqual([...live.toolStartedAt], [["call-1", 1_000]]);
    assert.deepEqual([...live.toolEndedAt], [["call-1", 1_600]]);

    vi.setSystemTime(2_000);
    trackThroughputEvent(live, { type: "tool_execution_start", toolCallId: "call-1" });
    assert.equal(live.toolStartedAt.size, 1);
    assert.equal(live.toolStartedAt.get("call-1"), 2_000);
    vi.setSystemTime(2_600);
    trackThroughputEvent(live, { type: "tool_execution_end", toolCallId: "call-1", result: "again" });
    assert.equal(live.toolEndedAt.size, 1);
    assert.equal(live.toolEndedAt.get("call-1"), 2_600);
  });
});
