import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { snapshotThroughput, THROUGHPUT_CUSTOM_TYPE, type ThroughputTiming } from "@/lib/token-throughput";
import { loadThroughputFromSession, restoredThroughputState, trackThroughputEvent } from "./harness";
import { VersionedThroughputMap } from "./versioned-throughput-map";
import { recordAssistantTokenUsage } from "@/lib/codexbar/token-usage";

vi.mock("@/lib/codexbar/token-usage", () => ({ recordAssistantTokenUsage: vi.fn() }));

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
          getSessionId: () => "test-session",
        },
      },
    } as unknown as Parameters<typeof trackThroughputEvent>[0],
    persisted,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("CodexBar final usage hook", () => {
  it("records finalized assistant usage with the executing account and session", () => {
    const { live } = liveState();
    live.accountId = "account-a";
    const message = { role: "assistant", timestamp: 1000, provider: "opencode-go", model: "gpt-test",
      stopReason: "stop", usage: { input: 300, output: 50, cacheRead: 100, cacheWrite: 0, totalTokens: 450 } };
    trackThroughputEvent(live, { type: "message_update", message });
    expectNoRecording();
    trackThroughputEvent(live, { type: "message_end", message });
    assert.deepEqual(vi.mocked(recordAssistantTokenUsage).mock.calls[0], ["test-session", "account-a", message]);
  });
  it("does not attribute tool-result aggregate usage to the main provider", () => {
    const { live } = liveState();
    trackThroughputEvent(live, { type: "message_end", message: { role: "toolResult", usage: { totalTokens: 100 } } });
    expectNoRecording();
  });
});

function expectNoRecording() {
  assert.equal(vi.mocked(recordAssistantTokenUsage).mock.calls.length, 0);
}

describe("loadThroughputFromSession", () => {
  it("returns empty collections when session entries are unavailable", () => {
    const session = {
      sessionManager: {
        getEntries: () => { throw new Error("entries unavailable"); },
      },
    } as unknown as Parameters<typeof loadThroughputFromSession>[0];

    const first = loadThroughputFromSession(session);
    const second = loadThroughputFromSession(session);

    assert.equal(first.timings.size, 0);
    assert.equal(first.persistedKeys.size, 0);
    assert.notEqual(first.timings, second.timings);
    assert.notEqual(first.persistedKeys, second.persistedKeys);
  });

  it("discards partial state when entry iteration fails", () => {
    const entries: Iterable<unknown> = {
      *[Symbol.iterator]() {
        yield {
          type: "custom", customType: THROUGHPUT_CUSTOM_TYPE,
          data: { startedAtMs: 1_000, firstTokenAtMs: 1_100, lastTokenAtMs: 1_500, outputTokens: 10 },
        };
        throw new Error("iteration failed");
      },
    };
    const session = {
      sessionManager: { getEntries: () => entries },
    } as unknown as Parameters<typeof loadThroughputFromSession>[0];

    const restored = loadThroughputFromSession(session);

    assert.equal(restored.timings.size, 0);
    assert.equal(restored.persistedKeys.size, 0);
  });
});

describe("restoredThroughputState", () => {
  it("reuses empty existing throughput collections by reference", () => {
    const existingTimings = new VersionedThroughputMap();
    const existingKeys = new Set<number>();
    const loadedTimings = new VersionedThroughputMap([[1_000, {
      startedAtMs: 1_000, firstTokenAtMs: 1_100, lastTokenAtMs: 1_500,
      outputTokens: 10, charCount: 0,
    }]]);
    const loadedKeys = new Set([1_000]);
    const existing = {
      throughputByStartedAt: existingTimings,
      persistedThroughputKeys: existingKeys,
    } as unknown as Parameters<typeof restoredThroughputState>[0];

    const restored = restoredThroughputState(existing, {
      timings: loadedTimings, persistedKeys: loadedKeys,
    }, null);

    assert.equal(restored.throughputByStartedAt, existingTimings);
    assert.equal(restored.persistedThroughputKeys, existingKeys);
  });

  it("wraps loaded timings and reuses loaded persisted keys without existing runtime", () => {
    const loadedTiming: ThroughputTiming = {
      startedAtMs: 1_000, firstTokenAtMs: 1_100, lastTokenAtMs: 1_500,
      outputTokens: 10, charCount: 0,
    };
    const loadedTimings = new Map([[1_000, loadedTiming]]);
    const loadedKeys = new Set([1_000]);

    const restored = restoredThroughputState(undefined, {
      timings: loadedTimings, persistedKeys: loadedKeys,
    }, null);

    assert.ok(restored.throughputByStartedAt instanceof VersionedThroughputMap);
    assert.notEqual(restored.throughputByStartedAt, loadedTimings);
    assert.equal(restored.throughputByStartedAt.get(1_000)?.outputTokens, 10);
    assert.equal(Object.isFrozen(restored.throughputByStartedAt.get(1_000)), true);
    assert.equal(restored.persistedThroughputKeys, loadedKeys);
  });

  it("creates empty throughput state that can accept and persist new events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const restored = restoredThroughputState(undefined, null, null);
    assert.ok(restored.throughputByStartedAt instanceof VersionedThroughputMap);
    assert.equal(restored.throughputByStartedAt.size, 0);
    assert.equal(restored.throughputByStartedAt.awaitingFirstTokenCount, 0);
    assert.equal(restored.persistedThroughputKeys.size, 0);

    const { live, persisted } = liveState();
    Object.assign(live, restored);
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
    vi.setSystemTime(1_200);
    trackThroughputEvent(live, {
      type: "message_end",
      message: { role: "assistant", timestamp: 1_000, usage: { output: 2 } },
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.equal(live.throughputByStartedAt.size, 1);
    assert.equal(live.persistedThroughputKeys.has(1_000), true);
    assert.equal(persisted.length, 1);
  });
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
    const startedTiming = timings.get(1_000)!;
    assert.equal(Object.isFrozen(startedTiming), true);
    vi.setSystemTime(1_100);
    trackThroughputEvent(live, {
      type: "message_update",
      message: { role: "assistant", timestamp: 1_000, usage: { output: 2 } },
      assistantMessageEvent: { type: "text_delta", delta: "ok" },
    });
    assert.equal(timings.revision, 2);
    assert.equal(timings.awaitingFirstTokenCount, 0);
    const updatedTiming = timings.get(1_000)!;
    assert.notEqual(updatedTiming, startedTiming);
    assert.equal(Object.isFrozen(updatedTiming), true);
    assert.equal(startedTiming.lastTokenAtMs, null);
    trackThroughputEvent(live, {
      type: "message_end",
      message: { role: "assistant", timestamp: 1_000, usage: { output: 2 } },
    });
    assert.equal(timings.revision, 3);
    assert.equal(timings.awaitingFirstTokenCount, 0);
    assert.notEqual(timings.get(1_000), updatedTiming);
    assert.equal(Object.isFrozen(timings.get(1_000)), true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.[0], "leafcode-pi.throughput");
    assert.equal((persisted[0]?.[1] as { outputTokens?: number }).outputTokens, 2);
  });

  it("does not append a throughput entry whose timestamp was already restored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { live, persisted } = liveState();
    live.throughputByStartedAt.set(1_000, {
      startedAtMs: 1_000, firstTokenAtMs: 1_000, lastTokenAtMs: 1_000,
      outputTokens: 2, charCount: 0,
    });
    live.persistedThroughputKeys.add(1_000);
    live.persistedThroughputKeys.add(1_000);

    trackThroughputEvent(live, {
      type: "message_end",
      message: { role: "assistant", timestamp: 1_000, usage: { output: 3 } },
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.equal(live.persistedThroughputKeys.size, 1);
    assert.equal(live.throughputByStartedAt.get(1_000)?.outputTokens, 3);
    assert.equal(persisted.length, 0);
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

  it("evicts the oldest live tool timing entries instead of growing per call", () => {
    vi.useFakeTimers();
    const { live } = liveState();

    vi.setSystemTime(0);
    for (let index = 0; index < 600; index += 1) {
      const callId = `call-${index}`;
      trackThroughputEvent(live, { type: "tool_execution_start", toolCallId: callId });
      trackThroughputEvent(live, { type: "tool_execution_end", toolCallId: callId, result: "done" });
    }

    assert.ok(live.toolStartedAt.size <= 512);
    assert.ok(live.toolEndedAt.size <= 512);
    // The newest call survives, and its end stamp is kept with its start stamp.
    assert.equal(live.toolStartedAt.get("call-599"), 0);
    assert.equal(live.toolEndedAt.get("call-599"), 0);
    assert.equal(live.toolStartedAt.has("call-0"), false);
    // Partial output stays bounded by the existing toolResult cleanup.
    assert.ok(live.toolPartialOutputByCallId.size <= 600);
  });

  it("evicts persisted throughput samples instead of growing one per assistant turn", async () => {
    vi.useFakeTimers();
    const { live, persisted } = liveState();

    for (let index = 0; index < 600; index += 1) {
      const startedAt = 1_000 + index;
      trackThroughputEvent(live, { type: "message_start", message: { role: "assistant", timestamp: startedAt } });
      // A finished turn is persisted, which is what makes the sample evictable.
      // Persistence is deferred to a microtask, so let it run before the next turn.
      trackThroughputEvent(live, {
        type: "message_end",
        message: { role: "assistant", timestamp: startedAt, usage: { output: 10 } },
      });
      await Promise.resolve();
    }

    assert.ok(live.throughputByStartedAt.size <= 512, `throughput map held ${live.throughputByStartedAt.size}`);
    // The newest turn is still projected, and its persisted marker stays with it.
    assert.equal(live.throughputByStartedAt.has(1_000 + 599), true);
    assert.equal(live.persistedThroughputKeys.has(1_000 + 599), true);
    // The oldest turns were dropped from both the map and the persisted set.
    assert.equal(live.throughputByStartedAt.has(1_000), false);
    assert.equal(live.persistedThroughputKeys.has(1_000), false);
    assert.ok(persisted.length > 0, "samples were still written to the session file");
  });

  it("keeps unpersisted throughput samples so a live turn never loses its tok/s", () => {
    vi.useFakeTimers();
    const { live } = liveState();

    for (let index = 0; index < 600; index += 1) {
      // message_start only: no message_end, so nothing is persisted.
      trackThroughputEvent(live, { type: "message_start", message: { role: "assistant", timestamp: 2_000 + index } });
    }

    // Unpersisted samples are never evicted, because dropping them would erase the
    // tok/s display for a turn that has not reached the session file yet.
    assert.equal(live.throughputByStartedAt.size, 600);
  });
});
