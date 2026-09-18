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
  it("preserves the tool call while removing a result Jev marks unnecessary", async () => {
    evaluateTypeSafe.mockResolvedValue({ answers: { "call-1": { noul: 0.2 } } });
    const result = await compactWithJev(preparation, 0.6, new AbortController().signal);
    expect(result?.summary).toContain("Tool call read: {\"path\":\"a.ts\"}");
    expect(result?.summary).toContain("[TOOLRESULT] read: omitted");
  });
});
