import { afterEach, describe, expect, it, vi } from "vitest";

const evaluateTypeSafe = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pi/typesafe-system-one", () => ({ evaluateTypeSafe }));

import { compactWithJev } from "./jev-compaction";

const preparation = {
  firstKeptEntryId: "keep",
  tokensBefore: 100,
  settings: { reserveTokens: 16_384 },
  turnPrefixMessages: [],
  messagesToSummarize: [
    { role: "user", content: [{ type: "text", text: "Fix it" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file body" }] },
  ],
};

afterEach(() => evaluateTypeSafe.mockReset());

describe("compactWithJev", () => {
  it("batches tool-result questions to stay under Jev request limits", async () => {
    const messages = Array.from({ length: 33 }, (_, index) => ({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "read",
      content: [{ type: "text", text: "file body" }],
    }));
    evaluateTypeSafe.mockResolvedValue({
      answers: Object.fromEntries(messages.map((message) => [message.toolCallId, { noul: 0.1 }])),
    });
    await compactWithJev({ ...preparation, messagesToSummarize: messages } as never, 0.6, new AbortController().signal);
    expect(evaluateTypeSafe).toHaveBeenCalledTimes(2);
  });

  it("gives Jev the exact result it is asked to judge", async () => {
    evaluateTypeSafe.mockResolvedValue({ answers: { "call-1": { noul: 0.2 } } });
    const result = await compactWithJev(preparation as never, 0.6, new AbortController().signal);
    expect(evaluateTypeSafe).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({
        toolResults: [{ id: "call-1", toolName: "read", text: "file body" }],
      }),
    }), expect.anything());
    expect(result?.summary).toContain("Tool call read: {\"path\":\"a.ts\"}");
    expect(result?.summary).toContain("[TOOLRESULT] read: omitted");
  });

  it("keeps oversized results without sending partial evidence to Jev", async () => {
    const large = "x".repeat(2_001);
    evaluateTypeSafe.mockResolvedValue({ answers: { small: { noul: 0.1 } } });
    const result = await compactWithJev({
      ...preparation,
      messagesToSummarize: [
        { role: "toolResult", toolCallId: "large", toolName: "powershell", content: [{ type: "text", text: large }] },
        { role: "toolResult", toolCallId: "small", toolName: "read", content: [{ type: "text", text: "stale" }] },
      ],
    } as never, 0.6, new AbortController().signal);
    expect(evaluateTypeSafe).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ toolResults: [{ id: "small", toolName: "read", text: "stale" }] }),
    }), expect.anything());
    expect(result?.summary).toContain(large);
  });

  it("falls back to Pi when the transcript exceeds its summary budget", async () => {
    evaluateTypeSafe.mockResolvedValue({ answers: { stale: { noul: 0.1 } } });
    const result = await compactWithJev({
      ...preparation,
      messagesToSummarize: [
        { role: "user", content: [{ type: "text", text: "x".repeat(53_000) }] },
        { role: "toolResult", toolCallId: "stale", toolName: "read", content: [{ type: "text", text: "stale" }] },
      ],
    } as never, 0.6, new AbortController().signal);
    expect(result).toBeUndefined();
  });

  it("keeps a result without a tool-call id when Jev retains it", async () => {
    evaluateTypeSafe.mockResolvedValue({ answers: { "result-0": { noul: 0.9 }, drop: { noul: 0.1 } } });
    const result = await compactWithJev({
      ...preparation,
      messagesToSummarize: [
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: "needed" }] },
        { role: "toolResult", toolCallId: "drop", toolName: "read", content: [{ type: "text", text: "stale" }] },
      ],
    } as never, 0.6, new AbortController().signal);
    expect(result?.summary).toContain("[TOOLRESULT]\nneeded");
  });

  it("falls back to Pi when its full compaction features are needed", async () => {
    for (const input of [
      { ...preparation, previousSummary: "prior work" },
      { ...preparation, turnPrefixMessages: [{ role: "assistant", content: [{ type: "text", text: "retained suffix" }] }] },
      { ...preparation, messagesToSummarize: [{ role: "bashExecution", output: "output" }] },
      { ...preparation, messagesToSummarize: [{ role: "user", content: [{ type: "image", data: "encoded", mimeType: "image/png" }] }] },
      { ...preparation, messagesToSummarize: [{ role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }] }] },
    ]) {
      const result = await compactWithJev(input as never, 0.6, new AbortController().signal);
      expect(result).toBeUndefined();
    }
    const focused = await compactWithJev(preparation as never, 0.6, new AbortController().signal, "retain errors");
    expect(focused).toBeUndefined();
    expect(evaluateTypeSafe).not.toHaveBeenCalled();
  });
});
