import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import {
  buildSinglePassCompaction,
  singlePassCompactionMessages,
  setupFastCompaction,
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
  it("does not resolve auth or summarize when the host owns compaction", async () => {
    const events = new EventEmitter();
    events.on("leafcode:compaction:owner", (request) => { request.claimed = true; });
    let handler!: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => unknown;
    setupFastCompaction({
      events: { emit: (name: string, data: unknown) => events.emit(name, data) },
      on: (_event: string, fn: typeof handler) => { handler = fn; },
    } as unknown as ExtensionAPI);
    const ctx = {
      get model() { throw new Error("Must not resolve a second compaction model"); },
    } as unknown as ExtensionContext;
    assert.equal(await handler({ preparation: preparation() } as SessionBeforeCompactEvent, ctx), undefined);
  });

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
