import type { CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionPreparation } from "./prepare-background-compaction";

type SummaryGenerator = typeof import("@earendil-works/pi-coding-agent").generateSummaryWithUsage;

/** Hook-generated file lists are not carried forward by Pi; retain them ourselves. */
function fileDetails(preparation: CompactionPreparation, branch: readonly SessionEntry[]) {
  const previous = [...branch].reverse().find((entry) => entry.type === "compaction");
  const details = previous?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
  const paths = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((path): path is string => typeof path === "string")
    : [];
  const modified = new Set([
    ...paths(details?.modifiedFiles), ...preparation.fileOps.edited, ...preparation.fileOps.written,
  ]);
  return {
    readFiles: [...new Set([...paths(details?.readFiles), ...preparation.fileOps.read])]
      .filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

/** One request for history + split-turn prefix, with an output budget independent of headroom. */
export async function compactSinglePass(options: {
  generate: SummaryGenerator;
  preparation: CompactionPreparation;
  branch: readonly SessionEntry[];
  model: Parameters<SummaryGenerator>[1];
  streamFn: NonNullable<Parameters<SummaryGenerator>[9]>;
  signal: AbortSignal;
  customInstructions?: string;
  thinkingLevel?: Parameters<SummaryGenerator>[8];
  summaryMaxTokens: number;
  mode: "foreground" | "background";
}): Promise<CompactionResult> {
  options.signal.throwIfAborted();
  const started = Date.now();
  const { preparation } = options;
  const { text, usage } = await options.generate(
    [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
    options.model,
    // Pi derives maxTokens as floor(reserve * 0.8). This is a summary budget,
    // NOT the actual compaction trigger's reserveTokens.
    Math.ceil(options.summaryMaxTokens / 0.8),
    undefined,
    undefined,
    options.signal,
    options.customInstructions,
    preparation.previousSummary,
    options.thinkingLevel ?? "off",
    (model, context, request) => options.streamFn(model, context, {
      ...request,
      maxTokens: Math.min(request?.maxTokens ?? options.summaryMaxTokens, options.summaryMaxTokens),
    }),
  );
  options.signal.throwIfAborted();
  if (!text.trim()) throw new Error("Compaction returned an empty summary");
  const files = fileDetails(preparation, options.branch);
  const fileText = [
    files.readFiles.length ? `<read-files>\n${files.readFiles.join("\n")}\n</read-files>` : "",
    files.modifiedFiles.length ? `<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>` : "",
  ].filter(Boolean).join("\n\n");
  return {
    summary: [text.trim(), fileText].filter(Boolean).join("\n\n"),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage,
    details: {
      ...files,
      leafcode: {
        version: 1,
        mode: options.mode,
        elapsedMs: Date.now() - started,
        summaryMaxTokens: options.summaryMaxTokens,
      },
    },
  };
}
