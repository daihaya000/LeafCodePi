import { describe, expect, it } from "vitest";
import { canInterruptForSteer, type ImmediateSteerState } from "./impact-aware-steer";

const generating: ImmediateSteerState = {
  isStreaming: true, isCompacting: false, blocked: false,
  pendingMessageCount: 0, promptQueueDepth: 1, activeToolNames: [],
};

describe("impact-aware immediate steering", () => {
  it("interrupts generation and known read-only tools", () => {
    expect(canInterruptForSteer(generating)).toBe(true);
    expect(canInterruptForSteer({ ...generating, activeToolNames: ["read", "grep", "find", "ls"] })).toBe(true);
  });

  it.each(["edit", "write", "bash", "powershell", "codemode", "subagent", "intercom", "act_ui", "question", "custom", "", "mcp_read", "web_search"])(
    "defers %s rather than guessing its cancellation impact", (name) => {
      expect(canInterruptForSteer({ ...generating, activeToolNames: ["read", name] })).toBe(false);
    },
  );

  it.each<Partial<ImmediateSteerState>>([
    { isStreaming: false }, { isCompacting: true }, { blocked: true },
    { pendingMessageCount: 1 }, { promptQueueDepth: 2 },
  ])("preserves preparation, compaction, pending work and queued input: %j", (state) => {
    expect(canInterruptForSteer({ ...generating, ...state })).toBe(false);
  });
});
