import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  applySubagentPermission,
  applyThroughput,
  applyToolTiming,
  isReasoningMandatoryError,
  reasoningFallbackLevel,
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
