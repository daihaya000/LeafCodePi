import { describe, expect, it, vi } from "vitest";
import { sessionContextUsage, snapshotMessages } from "./harness";

describe("snapshotMessages", () => {
  it("reuses stable history while projecting a changing streaming suffix", () => {
    const stored: unknown[] = [{ role: "user", content: "確認して" }];
    const fake = {
      messages: stored,
      agent: { state: { streamingMessage: undefined as unknown } },
      sessionManager: { getBranch: () => [] },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    const first = snapshotMessages(session);
    expect(snapshotMessages(session)).toBe(first);

    const streaming = {
      role: "assistant",
      content: [{ type: "text", text: "一" }],
    };
    fake.agent.state.streamingMessage = streaming;
    expect(snapshotMessages(session).at(-1)?.parts[0]).toMatchObject({ text: "一" });

    streaming.content[0]!.text = "二";
    expect(snapshotMessages(session).at(-1)?.parts[0]).toMatchObject({ text: "二" });
  });
});

describe("sessionContextUsage", () => {
  it("reuses the estimate while session messages are unchanged", () => {
    const stored: unknown[] = [{ role: "user", content: "確認して" }];
    const getContextUsage = vi.fn().mockReturnValue({
      tokens: 100,
      contextWindow: 10_000,
      percent: 1,
    });
    const fake = {
      messages: stored,
      getContextUsage,
    };
    const session = fake as unknown as Parameters<typeof sessionContextUsage>[0];

    const first = sessionContextUsage(session);
    expect(first).toEqual({ tokens: 100, contextWindow: 10_000, percent: 1 });
    expect(sessionContextUsage(session)).toBe(first);
    expect(getContextUsage).toHaveBeenCalledTimes(1);

    stored.push({ role: "assistant", content: [{ type: "text", text: "回答" }] });
    getContextUsage.mockReturnValue({
      tokens: 200,
      contextWindow: 10_000,
      percent: 2,
    });
    expect(sessionContextUsage(session)?.tokens).toBe(200);
    expect(getContextUsage).toHaveBeenCalledTimes(2);
  });
});
