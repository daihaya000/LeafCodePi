import { readIndexedSession, type SessionIndexRow } from "@backend-core/session-log-index.mjs";
import { InvalidTaskMessageCursorError, TASK_MESSAGE_PAGE_SIZE } from "@shared/task-history.mjs";
import { stripImageDataFromMessages } from "@shared/task-history-content.mjs";
import {
  goalLoopUiPrompt, isAgentSwitchMarker, isGoalLoopTurnMarker, isIntercomMessageMarker,
  piRawMessageProjectsToUi, projectPiMessages,
} from "./pi/messages";
import { applyThroughput } from "./pi/snapshot-messages";
import { restoreThroughputFromEntries, THROUGHPUT_CUSTOM_TYPE } from "./token-throughput";
import type { UiMessage } from "./types";

type Metadata = {
  raw: boolean; role: string | null; agent: boolean; goal: boolean;
  intercom: boolean; userReset: boolean; customReset: boolean; compactionReset: boolean;
  resumeReset: boolean; startedAt: number | null; throughputAt: number | null;
};
export type SessionHistoryPage = { messages: UiMessage[]; messageHistory: { hasMore: boolean; nextCursor: string | null } };
function rawMessage(entry: any): any {
  if (entry.type === "message") return entry.message;
  const timestamp = Date.parse(entry.timestamp);
  if (entry.type === "compaction") return { id: entry.id, role: "compactionSummary", timestamp, summary: entry.summary, tokensBefore: entry.tokensBefore };
  if (entry.type !== "custom_message") return null;
  const raw = { id: entry.id, role: "custom", timestamp, customType: entry.customType, content: entry.content, display: entry.display, details: entry.details };
  return piRawMessageProjectsToUi(raw) || isAgentSwitchMarker(raw) || isGoalLoopTurnMarker(raw) || isIntercomMessageMarker(raw) ? raw : null;
}
function classify(entry: any): Metadata {
  const raw = rawMessage(entry), visible = piRawMessageProjectsToUi(raw);
  const intercom = isIntercomMessageMarker(raw);
  const role = !visible ? null : raw.role === "custom" ? (goalLoopUiPrompt(raw) !== null ? "user" : "assistant") : raw.role;
  return {
    raw: Boolean(raw), role,
    agent: isAgentSwitchMarker(raw), goal: isGoalLoopTurnMarker(raw), intercom,
    userReset: raw?.role === "user", customReset: raw?.role === "custom" && !intercom,
    compactionReset: raw?.role === "compactionSummary",
    resumeReset: raw?.role === "custom" && visible && role === "assistant",
    startedAt: raw?.role === "assistant" && Number.isFinite(raw.timestamp) ? raw.timestamp : null,
    throughputAt: entry.type === "custom" && entry.customType === THROUGHPUT_CUSTOM_TYPE && Number.isFinite(entry.data?.startedAtMs) ? entry.data.startedAtMs : null,
  };
}
/** Read-only UI history is independent of the model's summary + verbatim recent context. */
export async function readSessionHistoryPage(path: string, before: string | null = null, limit = TASK_MESSAGE_PAGE_SIZE, signal?: AbortSignal): Promise<SessionHistoryPage> {
  const cursor = before?.trim() || null;
  const { entries, selection } = await readIndexedSession(path, {
    kind: "ui-history-v2", classify, signal,
    select(branch: readonly SessionIndexRow<Metadata>[]) {
      const visible = branch.filter((row) => row.role !== null);
      const end = cursor === null ? visible.length : visible.findLastIndex((row) => row.id === cursor);
      if (end < 0) throw new InvalidTaskMessageCursorError();
      // Before the first visible row there is no page and no marker state to hydrate.
      if (end === 0) return { ids: [], ordinals: new Map<string, number>(), wanted: [], hasMore: false, nextCursor: null };
      let start = Math.max(0, end - (Number.isSafeInteger(limit) && limit > 0 ? limit : TASK_MESSAGE_PAGE_SIZE));
      if (start > 0 && visible[start]?.role !== "user") {
        for (let at = start - 1; at >= 0; at--) if (visible[at].role === "user") { start = at; break; }
      }
      const page = visible.slice(start, end), wanted = new Set(page.map((row) => row.id));
      const first = page.length ? branch.findIndex((row) => row.id === page[0].id) : branch.length;
      const stop = end < visible.length ? branch.findIndex((row) => row.id === visible[end].id) : branch.length;
      const include = new Set<string>();
      let firstAgent: string | null = null, agent: string | null = null, goal: string | null = null, intercom: string | null = null;
      for (let at = 0; at < first; at++) {
        const row = branch[at];
        if (row.agent) { firstAgent ??= row.id; agent = row.id; }
        if (row.userReset || row.resumeReset) goal = null;
        if (row.goal) goal = row.id;
        if (row.userReset || row.customReset || row.compactionReset) intercom = null;
        if (row.intercom) intercom = row.id;
      }
      // The first switch also establishes the persona before that switch.
      firstAgent ??= branch.find((row) => row.agent)?.id ?? null;
      if (page.length) for (const id of [firstAgent, agent, goal, intercom]) if (id) include.add(id);
      const starts = new Set<number>();
      for (let at = first; at < stop; at++) {
        const row = branch[at]; if (row.raw) include.add(row.id);
        if (row.startedAt !== null) starts.add(row.startedAt);
      }
      for (const row of branch) if (row.throughputAt !== null && starts.has(row.throughputAt)) include.add(row.id);
      const ordinals = new Map<string, number>(); let ordinal = 0;
      for (const row of branch) { if (include.has(row.id)) ordinals.set(row.id, ordinal); if (row.raw) ordinal++; }
      return { ids: branch.filter((row) => include.has(row.id)).map((row) => row.id), ordinals,
        wanted: [...wanted], hasMore: start > 0, nextCursor: start > 0 ? page[0]?.id ?? null : null };
    },
  });
  const raw: any[] = [], entryIds = new Map<unknown, string>();
  for (const entry of entries) {
    const message = rawMessage(entry); if (!message) continue;
    // Avoid caching base64 data URLs in the UI projector. Images load through the existing image endpoint.
    const content = Array.isArray(message.content) ? message.content.map((part: any) => part?.type === "image" && part.data ? { ...part, data: "AA==" } : part) : message.content;
    const item = { ...message, id: typeof message.id === "string" && message.id ? message.id : `msg-${selection.ordinals.get(entry.id)}`, content };
    raw.push(item); if (piRawMessageProjectsToUi(item)) entryIds.set(item, entry.id);
  }
  const projected = projectPiMessages(raw), ids = [...entryIds.values()], wanted = new Set(selection.wanted);
  const messages = projected.map((message, at) => ({ ...message, id: ids[at] ?? message.id })).filter((message) => wanted.has(message.id));
  return { messages: stripImageDataFromMessages(applyThroughput(messages, restoreThroughputFromEntries(entries).timings)),
    messageHistory: { hasMore: selection.hasMore, nextCursor: selection.nextCursor } };
}
