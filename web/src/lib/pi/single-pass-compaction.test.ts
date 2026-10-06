import { SessionManager, buildSessionProjection, estimateTokens, findCutPoint } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { compactSinglePass } from "./single-pass-compaction";
import { prepareBackgroundCompaction, type CompactionPreparation } from "./prepare-background-compaction";
import { parseBackgroundCompactionThreshold, parseCompactionSummaryMaxTokens } from "@/lib/compaction-settings";

const sdk = { buildSessionProjection, estimateTokens, findCutPoint };
const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 10 };
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

function fixture() {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage(user("old goal ".repeat(100)));
  manager.appendMessage(fauxAssistantMessage("old decision ".repeat(100)));
  const kept = manager.appendMessage(user("current goal ".repeat(100)));
  manager.appendMessage(fauxAssistantMessage("current answer"));
  return { manager, kept };
}

describe("background preparation with the public Pi projection", () => {
  it("retains a complete recent turn and keeps the raw log unchanged", () => {
    const { manager, kept } = fixture();
    const branch = manager.getBranch();
    const before = JSON.stringify(branch);
    const prep = prepareBackgroundCompaction(sdk, branch, settings)!;
    expect(prep.firstKeptEntryId).toBe(kept);
    expect(JSON.stringify(prep.messagesToSummarize)).toContain("old decision");
    expect(JSON.stringify(prep.messagesToSummarize)).not.toContain("current goal");
    expect(JSON.stringify(manager.getBranch())).toBe(before);
  });

  it("uses replacements, excludes omissions, and retains the previous checkpoint", () => {
    const { manager, kept } = fixture();
    manager.appendCompaction("previous checkpoint", kept, 2_000, { modifiedFiles: ["old.ts"] }, true);
    manager.appendMessage(user("after checkpoint ".repeat(100)));
    const omit = manager.appendMessage(fauxAssistantMessage("OMITTED SECRET"));
    manager.appendContextEdit(omit, null);
    manager.appendContextEdit(kept, { content: "REPLACEMENT ".repeat(100) });
    manager.appendMessage(user("latest ".repeat(100)));
    manager.appendMessage(fauxAssistantMessage("answer"));
    const prep = prepareBackgroundCompaction(sdk, manager.getBranch(), settings)!;
    expect(prep.previousSummary).toBe("previous checkpoint");
    const input = JSON.stringify([prep.messagesToSummarize, prep.turnPrefixMessages]);
    expect(input).toContain("REPLACEMENT");
    expect(input).not.toContain("OMITTED SECRET");
    expect(input).not.toContain("old decision");
    expect(input).not.toContain("current goal");
  });

  it("never cuts between a tool call and its result and tracks codemode file operations", () => {
    const manager = SessionManager.inMemory(process.cwd());
    manager.appendMessage(user("task ".repeat(100)));
    const call = manager.appendMessage(fauxAssistantMessage([
      { type: "toolCall", id: "call", name: "codemode", arguments: { code: "read files" } },
    ], { stopReason: "toolUse" }));
    manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "codemode",
      content: [{ type: "text", text: "result ".repeat(200) }], isError: false, timestamp: 2,
      nestedCalls: { calls: [{ name: "edit", arguments: { path: "nested.ts" } }] },
    } as never);
    let prep = prepareBackgroundCompaction(sdk, manager.getBranch(), settings)!;
    expect(prep.firstKeptEntryId).toBe(call);
    manager.appendMessage(fauxAssistantMessage("finished ".repeat(100)));
    prep = prepareBackgroundCompaction(sdk, manager.getBranch(), settings)!;
    expect(prep.turnPrefixMessages.length).toBeGreaterThan(0);
    expect(prep.fileOps.edited.has("nested.ts")).toBe(true);
  });

  it("skips empty sessions and a newly appended checkpoint", () => {
    expect(prepareBackgroundCompaction(sdk, [], settings)).toBeUndefined();
    const { manager, kept } = fixture();
    manager.appendCompaction("checkpoint", kept, 2_000);
    expect(prepareBackgroundCompaction(sdk, manager.getBranch(), settings)).toBeUndefined();
  });
});

describe("single-pass summarization", () => {
  function input() {
    const { manager, kept } = fixture();
    manager.appendCompaction("previous", kept, 1_000, { readFiles: ["read.ts"], modifiedFiles: ["old.ts"] }, true);
    const prep: CompactionPreparation = {
      firstKeptEntryId: kept, messagesToSummarize: [user("history")],
      turnPrefixMessages: [user("split prefix")], previousSummary: "previous", isSplitTurn: true,
      tokensBefore: 900_000, settings: { ...settings, reserveTokens: 100_000 },
      fileOps: { read: new Set(["new.ts"]), edited: new Set(["read.ts"]), written: new Set(["new.ts"]) },
    };
    const usage = fauxAssistantMessage("summary").usage;
    const generate = vi.fn().mockResolvedValue({ text: "summary", usage });
    return { generate, preparation: prep, branch: manager.getBranch(), model: {} as never,
      streamFn: vi.fn() as never, signal: new AbortController().signal,
      summaryMaxTokens: 4_096, mode: "background" as const, usage };
  }

  it("makes one request with separate output budget, cumulative files, timing and usage", async () => {
    const options = input();
    const result = await compactSinglePass(options);
    expect(options.generate).toHaveBeenCalledOnce();
    const args = options.generate.mock.calls[0];
    expect(args[0]).toHaveLength(2);
    expect(args[2]).toBe(5_120); // 4096 output, not 80% of 100000 headroom
    expect(args[7]).toBe("previous");
    expect(args[8]).toBe("off");
    expect(result.usage).toEqual(options.usage);
    expect(result.details).toMatchObject({ readFiles: [], modifiedFiles: ["new.ts", "old.ts", "read.ts"],
      leafcode: { mode: "background", summaryMaxTokens: 4_096, elapsedMs: expect.any(Number) } });
    expect(result.summary).toContain("<modified-files>");
  });

  it("rejects empty, failed or cancelled generations", async () => {
    const options = input();
    options.generate.mockResolvedValue({ text: "  ", usage: options.usage });
    await expect(compactSinglePass(options)).rejects.toThrow("empty summary");
    options.generate.mockRejectedValue(new Error("Summarization hit output limit"));
    await expect(compactSinglePass(options)).rejects.toThrow("output limit");
    const controller = new AbortController();
    options.generate.mockImplementation(async () => {
      controller.abort(); return { text: "late", usage: options.usage };
    });
    await expect(compactSinglePass({ ...options, signal: controller.signal })).rejects.toThrow();
  });

  it("validates server settings without linking summary size to headroom", () => {
    for (const value of [null, "", "-1", "0", "NaN", "1.5", "20000"]) {
      expect(parseCompactionSummaryMaxTokens(value)).toBe(4096);
    }
    expect(parseCompactionSummaryMaxTokens("2048")).toBe(2048);
    expect(parseBackgroundCompactionThreshold("80")).toBe(80);
    expect(parseBackgroundCompactionThreshold("95")).toBe(70);
  });
});
