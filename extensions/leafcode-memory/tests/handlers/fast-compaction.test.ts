import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSinglePassCompaction,
  singlePassCompactionMessages,
} from "../../src/handlers/fast-compaction.js";

function preparation() {
  return {
    firstKeptEntryId: "keep-1",
    messagesToSummarize: [{ role: "user", content: "history" }],
    turnPrefixMessages: [{ role: "assistant", content: "prefix" }],
    isSplitTurn: true,
    tokensBefore: 42_000,
    previousSummary: "previous",
    settings: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
    fileOps: {
      read: new Set(["read.ts", "changed.ts"]),
      edited: new Set(["changed.ts"]),
      written: new Set(["new.ts"]),
    },
  } as never;
}

describe("fast compaction", () => {
  it("summarizes history and a split-turn prefix in one message list", () => {
    assert.equal(singlePassCompactionMessages(preparation()).length, 2);
  });

  it("preserves compaction metadata and file details", () => {
    const result = buildSinglePassCompaction(preparation(), "summary");

    assert.deepEqual(result, {
      summary: "summary",
      firstKeptEntryId: "keep-1",
      tokensBefore: 42_000,
      details: {
        readFiles: ["read.ts"],
        modifiedFiles: ["changed.ts", "new.ts"],
      },
    });
  });
});
