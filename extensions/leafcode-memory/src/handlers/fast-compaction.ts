import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  generateSummary,
  type CompactionResult,
} from "@earendil-works/pi-coding-agent";
import { resolveRequestAuth, resolveReviewModel } from "./review-memory-ops.js";

type CompactionPreparation = {
  firstKeptEntryId: string;
  messagesToSummarize: Parameters<typeof generateSummary>[0];
  turnPrefixMessages: Parameters<typeof generateSummary>[0];
  tokensBefore: number;
  previousSummary?: string;
  customInstructions?: string;
  settings: { reserveTokens?: number };
  fileOps: {
    read: Set<string>;
    edited: Set<string>;
    written: Set<string>;
  };
};

type FileOps = CompactionPreparation["fileOps"];

/** Merge the history and split-turn prefix into the single summary input. */
export function singlePassCompactionMessages(preparation: CompactionPreparation) {
  return [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ];
}

function fileDetails(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

export function buildSinglePassCompaction(
  preparation: CompactionPreparation,
  summary: string,
): CompactionResult {
  return {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: fileDetails(preparation.fileOps),
  };
}

/**
 * Replace Pi's split-turn two-pass summary with one normal summary request.
 * ponytail: the split-turn-specific format is less explicit, but one LLM pass
 * is preferable to blocking the user on a second equivalent summary request.
 */
export function setupFastCompaction(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, ctx) => {
    const model = resolveReviewModel(ctx.model, ctx.modelRegistry, {});
    if (!model) return;

    const messages = singlePassCompactionMessages(event.preparation);
    if (messages.length === 0) return;

    const auth = await resolveRequestAuth(ctx.modelRegistry, model);
    if (!auth.ok || !auth.apiKey) return;

    const summary = await generateSummary(
      messages,
      model,
      event.preparation.settings.reserveTokens ?? 16_384,
      auth.apiKey,
      auth.headers,
      event.signal,
      event.customInstructions,
      event.preparation.previousSummary,
      "off",
      undefined,
      auth.env,
    );
    if (!summary.trim()) return;

    return { compaction: buildSinglePassCompaction(event.preparation, summary) };
  });
}
