import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export type CompactionPreparation = Parameters<typeof import("@earendil-works/pi-coding-agent").compact>[0];
export type ResolvedCompactionSettings = CompactionPreparation["settings"];
type Pi = Pick<typeof import("@earendil-works/pi-coding-agent"), "buildSessionProjection" | "findCutPoint" | "estimateTokens">;

/**
 * prepareCompaction is private in Pi 1.0. Use its public projection + cut selector
 * instead. Materialize edited messages before selecting a cut; omitted messages and
 * prompt-state entries must never leak back into a checkpoint. No raw log mutation.
 */
export function prepareBackgroundCompaction(
  pi: Pi,
  branch: SessionEntry[],
  settings: ResolvedCompactionSettings,
): CompactionPreparation | undefined {
  if (branch.at(-1)?.type === "compaction") return undefined;
  const projection = pi.buildSessionProjection(branch);
  const previous = projection.entries.find((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length);
  const previousSummary = previous?.sourceEntry.type === "compaction" ? previous.sourceEntry.summary : undefined;
  const entries: SessionMessageEntry[] = projection.entries.flatMap((entry) =>
    entry.sourceEntry.type === "compaction" ? [] : entry.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        type: "message" as const, id: entry.sourceEntry.id, parentId: entry.sourceEntry.parentId,
        timestamp: entry.sourceEntry.timestamp, message,
      })),
  );
  if (!entries.length) return undefined;
  const cut = pi.findCutPoint(entries, 0, entries.length, settings.keepRecentTokens);
  let end = cut.firstKeptEntryIndex;
  // One source entry may project to several messages. Keep the entire source group.
  while (end > 0 && entries[end - 1].id === entries[end]?.id) end--;
  if (end <= 0 || !entries[end]) return undefined;
  const historyEnd = cut.isSplitTurn && cut.turnStartIndex < end ? cut.turnStartIndex : end;
  const messagesToSummarize = entries.slice(0, historyEnd).map((entry) => entry.message);
  const turnPrefixMessages = entries.slice(historyEnd, end).map((entry) => entry.message);
  const fileOps = { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() };
  const track = (name: string, args: unknown) => {
    const path = args && typeof args === "object" ? (args as { path?: unknown }).path : undefined;
    if (typeof path !== "string") return;
    if (name === "read") fileOps.read.add(path);
    else if (name === "edit") fileOps.edited.add(path);
    else if (name === "write") fileOps.written.add(path);
  };
  for (const message of [...messagesToSummarize, ...turnPrefixMessages]) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") track(block.name, block.arguments);
    } else if (message.role === "toolResult") {
      for (const call of message.nestedCalls?.calls ?? []) track(call.name, call.arguments);
    }
  }
  return {
    firstKeptEntryId: entries[end].id,
    messagesToSummarize, turnPrefixMessages, isSplitTurn: turnPrefixMessages.length > 0,
    tokensBefore: projection.messages.reduce((total, message) => total + pi.estimateTokens(message), 0),
    previousSummary, fileOps, settings,
  };
}
