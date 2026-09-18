import { describe, expect, it, vi } from "vitest";

const evaluateTypeSafe = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pi/typesafe-system-one", () => ({ evaluateTypeSafe }));

import { compactWithJev } from "./jev-compaction";

const preparation = {
  firstKeptEntryId: "keep",
  tokensBefore: 100,
  messagesToSummarize: [
    { role: "user", content: [{ type: "text", text: "Fix it" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file body" }] },
  ],
};

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
    await compactWithJev({ ...preparation, messagesToSummarize: messages }, 0.6, new AbortController().signal);
    expect(evaluateTypeSafe).toHaveBeenCalledTimes(2);
  });

  it("preserves the tool call while removing a result Jev marks unnecessary", async () => {
    evaluateTypeSafe.mockResolvedValue({ answers: { "call-1": { noul: 0.2 } } });
    const result = await compactWithJev(preparation, 0.6, new AbortController().signal);
    expect(result?.summary).toContain("Tool call read: {\"path\":\"a.ts\"}");
    expect(result?.summary).toContain("[TOOLRESULT] read: omitted");
  });
});
