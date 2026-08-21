import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { applySubagentPermission, applyToolTiming, decoratePrompt } from "./harness";
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

describe("decoratePrompt", () => {
  it("returns the prompt unchanged without options", () => {
    assert.equal(decoratePrompt("Do the thing"), "Do the thing");
  });

  it("prepends an agent delegation instruction", () => {
    const result = decoratePrompt("Fix the bug", { agent: "worker" });
    assert.match(result, /サブエージェント「worker」に委譲/);
    assert.match(result, /agent: "worker"/);
    assert.ok(result.endsWith("Fix the bug"));
  });

  it("leaves the prompt unchanged when subagent is denied (mechanical enforcement only)", () => {
    const result = decoratePrompt("Fix the bug", { subagentPermission: "deny" });
    assert.equal(result, "Fix the bug");
  });

  it("prepends only the agent instruction when agent is chosen and deny is set", () => {
    const result = decoratePrompt("Fix", { agent: "scout", subagentPermission: "deny" });
    assert.match(result, /scout/);
    assert.doesNotMatch(result, /禁止されています/);
  });
});

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
