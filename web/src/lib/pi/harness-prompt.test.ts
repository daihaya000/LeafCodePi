import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  applySubagentPermission,
  applyToolOutput,
  applyThroughput,
  applyToolTiming,
  buildPromptOptions,
  clearSessionQueue,
  isReasoningMandatoryError,
  isStaleHarnessPrompt,
  nextPromptEpoch,
  reasoningFallbackLevel,
  resolveStreamingBehaviorForPrompt,
  shouldBypassPromptChain,
  shouldWaitForSteerStream,
  syncSessionName,
  waitForSessionStreaming,
  cancelPendingTaskSnapshot,
} from "./harness";
import type { ThroughputTiming } from "@/lib/token-throughput";
import type { UiMessage } from "@/lib/types";

function toolMessage(callID: string): UiMessage {
  return {
    id: `m-${callID}`,
    role: "assistant",
    createdAt: 1,
    parts: [
      { id: `p-${callID}`, type: "tool", tool: "bash", callID, state: { status: "running" } },
    ],
  };
}

describe("applySubagentPermission", () => {
  function mockSession(initial: string[]) {
    let names = [...initial];
    return {
      getActiveToolNames: () => [...names],
      setActiveToolsByName: (next: string[]) => {
        names = [...next];
      },
      names: () => [...names],
    };
  }

  it("adds subagent when allow and absent", () => {
    const s = mockSession(["read", "bash"]);
    applySubagentPermission(s as never, "allow");
    assert.deepEqual(s.names(), ["read", "bash", "subagent"]);
  });

  it("removes subagent when deny and present", () => {
    const s = mockSession(["read", "bash", "subagent"]);
    applySubagentPermission(s as never, "deny");
    assert.deepEqual(s.names(), ["read", "bash"]);
  });

  it("defaults to deny when undefined", () => {
    const s = mockSession(["read", "bash", "subagent"]);
    applySubagentPermission(s as never, undefined);
    assert.deepEqual(s.names(), ["read", "bash"]);
  });

  it("is idempotent", () => {
    const s = mockSession(["read", "bash"]);
    applySubagentPermission(s as never, "deny");
    assert.deepEqual(s.names(), ["read", "bash"]);
  });
});

describe("harness prompt abort generation", () => {
  it("treats a queued prompt as stale after abort bumps the epoch", () => {
    const started = 0;
    const afterAbort = nextPromptEpoch(started);
    assert.equal(afterAbort, 1);
    assert.equal(isStaleHarnessPrompt(started, afterAbort), true);
    assert.equal(isStaleHarnessPrompt(afterAbort, afterAbort), false);
  });
});

describe("buildPromptOptions", () => {
  it("marks watchdog retries as extension input in the options passed to prompt", () => {
    assert.deepEqual(
      buildPromptOptions({ isHangRetry: true, isStreaming: false }),
      { source: "extension" },
    );
  });

  it("preserves image and streaming behavior for ordinary prompts", () => {
    assert.deepEqual(
      buildPromptOptions({
        images: [{ data: "image-data", mimeType: "image/png" }],
        streamingBehavior: "steer",
        isHangRetry: false,
        isStreaming: true,
      }),
      {
        images: [{ type: "image", data: "image-data", mimeType: "image/png" }],
        streamingBehavior: "steer",
      },
    );
    assert.deepEqual(
      buildPromptOptions({ isHangRetry: false, isStreaming: true }),
      { streamingBehavior: "followUp" },
    );
    assert.deepEqual(
      buildPromptOptions({ isHangRetry: true, isStreaming: true }),
      { source: "extension" },
    );
  });

  it("bypasses the prompt chain for steer even before streaming starts", () => {
    assert.equal(shouldBypassPromptChain("steer"), true);
    assert.equal(shouldBypassPromptChain("followUp"), true);
    assert.equal(shouldBypassPromptChain(undefined), false);
  });

  it("drops steer once the current turn is no longer streaming", () => {
    assert.equal(resolveStreamingBehaviorForPrompt("steer", false), undefined);
    assert.equal(resolveStreamingBehaviorForPrompt("steer", true), "steer");
    assert.equal(resolveStreamingBehaviorForPrompt(undefined, true), undefined);
  });

  it("waits for the session stream before injecting steer", async () => {
    let streaming = false;
    let ticks = 0;
    const ok = await waitForSessionStreaming(
      () => streaming,
      () => true,
      {
        timeoutMs: 1_000,
        pollMs: 1,
        sleep: async () => {
          ticks += 1;
          if (ticks >= 3) streaming = true;
        },
      },
    );
    assert.equal(ok, true);
    assert.ok(ticks >= 3);

    const abandoned = await waitForSessionStreaming(
      () => false,
      () => false,
      { timeoutMs: 100, pollMs: 1, sleep: async () => undefined },
    );
    assert.equal(abandoned, false);
  });

  it("waits for steer only while the accepted prompt is still active", () => {
    assert.equal(
      shouldWaitForSteerStream({ isStreaming: false, promptActive: true }),
      true,
    );
    assert.equal(
      shouldWaitForSteerStream({ isStreaming: true, promptActive: true }),
      false,
    );
    assert.equal(
      shouldWaitForSteerStream({ isStreaming: false, promptActive: false }),
      false,
    );
  });
});

describe("clearSessionQueue", () => {
  it("swallows clearQueue failures so abort can still proceed", () => {
    assert.doesNotThrow(() =>
      clearSessionQueue({
        clearQueue: () => {
          throw new Error("queue locked");
        },
      }),
    );
    let calls = 0;
    clearSessionQueue({
      clearQueue: () => {
        calls += 1;
      },
    });
    assert.equal(calls, 1);
    clearSessionQueue({});
  });
});

describe("cancelPendingTaskSnapshot", () => {
  it("clears a throttled timer without flushing", () => {
    const live = {
      snapshotTimer: setTimeout(() => {
        throw new Error("should not flush");
      }, 60_000) as ReturnType<typeof setTimeout>,
      pendingSnapshotEventType: "message_update",
      pendingSnapshotIsDelta: true,
      pendingSnapshotExtra: { keep: true },
    };
    assert.equal(cancelPendingTaskSnapshot(live), true);
    assert.equal(live.snapshotTimer, null);
    assert.equal(live.pendingSnapshotEventType, null);
    assert.equal(live.pendingSnapshotIsDelta, false);
    assert.equal(live.pendingSnapshotExtra, undefined);
    assert.equal(cancelPendingTaskSnapshot(live), false);
  });
});

describe("syncSessionName", () => {
  it("persists the task title once for extensions to read", () => {
    let current: string | undefined;
    const entries: string[] = [];
    const manager = {
      getSessionName: () => current,
      appendSessionInfo: (name: string) => {
        current = name;
        entries.push(name);
      },
    };

    syncSessionName(manager, "設定モデルタブを整理");
    syncSessionName(manager, "設定モデルタブを整理");
    assert.deepEqual(entries, ["設定モデルタブを整理"]);
  });
});

describe("applyToolTiming", () => {
  it("injects start/end timestamps into matching tool parts", () => {
    const messages = [toolMessage("call-1"), toolMessage("call-2")];
    const started = new Map([["call-1", 1000], ["call-2", 2000]]);
    const ended = new Map([["call-1", 5000]]);
    const result = applyToolTiming(messages, started, ended);
    const part1 = result[0]!.parts[0] as Extract<(typeof result)[0]["parts"][number], { type: "tool" }>;
    const part2 = result[1]!.parts[0] as Extract<(typeof result)[1]["parts"][number], { type: "tool" }>;
    assert.equal(part1.state.startedAtMs, 1000);
    assert.equal(part1.state.endedAtMs, 5000);
    assert.equal(part2.state.startedAtMs, 2000);
    assert.equal(part2.state.endedAtMs, undefined);
  });

  it("leaves unmatched parts untouched", () => {
    const messages = [toolMessage("call-1")];
    const result = applyToolTiming(messages, new Map(), new Map());
    const part = result[0]!.parts[0] as Extract<(typeof result)[0]["parts"][number], { type: "tool" }>;
    assert.equal(part.state.startedAtMs, undefined);
  });
});

describe("applyToolOutput", () => {
  it("injects cumulative partial output into a running tool", () => {
    const result = applyToolOutput(
      [toolMessage("call-1")],
      new Map([["call-1", "line 1\nline 2"]]),
    );
    const part = result[0]!.parts[0] as Extract<(typeof result)[0]["parts"][number], { type: "tool" }>;
    assert.equal(part.state.output, "line 1\nline 2");
  });

  it("does not overwrite a finalized tool result", () => {
    const message = toolMessage("call-1");
    const part = message.parts[0] as Extract<(typeof message)["parts"][number], { type: "tool" }>;
    part.state.status = "completed";
    part.state.output = "final";
    const output = applyToolOutput([message], new Map([["call-1", "partial"]]))[0]!.parts[0] as Extract<
      (typeof message)["parts"][number],
      { type: "tool" }
    >;
    assert.equal(output.state.output, "final");
  });
});

describe("reasoning mandatory fallback", () => {
  it("detects the reasoning-mandatory 400 message", () => {
    assert.equal(
      isReasoningMandatoryError(new Error('400: {"message":"Reasoning is mandatory for this endpoint and cannot be disabled."}')),
      true,
    );
    assert.equal(isReasoningMandatoryError(new Error("some other error")), false);
  });

  it("defaults to minimal when no model is available", () => {
    assert.equal(reasoningFallbackLevel(null), "minimal");
    assert.equal(reasoningFallbackLevel(undefined), "minimal");
  });
});

describe("applyThroughput", () => {
  function assistantMessage(createdAt: number): UiMessage {
    return { id: "a", role: "assistant", createdAt, parts: [] };
  }

  function timing(startedAtMs: number): ThroughputTiming {
    return {
      startedAtMs,
      firstTokenAtMs: startedAtMs + 500,
      lastTokenAtMs: startedAtMs + 9500,
      outputTokens: 100,
      charCount: 0,
    };
  }

  it("injects the measured response duration (last token − start)", () => {
    // 回帰: 直前レコードとの差分近似は assistant timestamp が生成開始時刻の
    // ため常に 0s を表示した。実測 lastToken から計算する。
    const result = applyThroughput([assistantMessage(1_000)], new Map([[1_000, timing(1_000)]]));
    assert.equal(result[0]!.responseDurationMs, 9_500);
  });

  it("leaves messages without timing untouched instead of fabricating a duration", () => {
    const result = applyThroughput([assistantMessage(2_000)], new Map([[1_000, timing(1_000)]]));
    assert.equal(result[0]!.responseDurationMs, undefined);
  });
});
