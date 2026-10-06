import { pageTaskDetailMessages } from "@/lib/task-history";
import { forwardTaskDetail, forwardTaskPendingRequests } from "@/lib/backend-forward";
import { readHistoryPageSize } from "@/lib/pi/history-page-size";
import {
  BACKEND_TASK_STREAM_REASON,
  isBackendTaskDirtyConnected,
  subscribeBackendTaskDirty,
  type BackendTaskDirtyPayload,
} from "@/lib/backend-task-dirty-hub";

/**
 * The event stream of a task this process does not own.
 *
 * After the cutover the Backend owns the session, so a WebUI stream must be built from the Backend's
 * detail — never from a local subscription or an `ensureLive` — and refreshed by polling or by a
 * Backend dirty wake. The pending approval/question lives in the owner's memory, so it comes from
 * the Backend's pending snapshots too: without that the approval prompt would never appear after
 * the cutover.
 *
 * Idle polls use `messages=omit` and keep the last page locally when `messageRevision` is unchanged,
 * so the owner skips full history projection. Streaming/compacting and revision changes still fetch
 * a page. Dirty wakes are coalesced in a short window; a slow idle timer remains as a safety net.
 * Notices received during a read are retained for a follow-up, never dropped.
 *
 * Streaming-text wakes (`reason: "stream"`) read a page directly, so the first tokens do not pay an
 * extra omit round-trip. A working task (prompt accepted, stream not open yet) keeps the short poll,
 * and the long dirty-attached idle poll only applies while the hub is actually connected: a missed
 * wake must not hold a sent message back for 30 seconds.
 *
 * An initial failed read is reported to the caller, which ends the stream with an error. Failed polls
 * retry on the next tick; falling back to an in-process session would report a state we do not own.
 */

/** What the helper needs from an SSE writer; `createSseWriter` satisfies it. */
export type BackendEventSink = {
  send(event: string, payload: unknown): void;
  sendSerialized?(event: string, json: string): void;
  readonly closed: boolean;
};

export const BACKEND_EVENT_POLL_MS = 2_000;
/**
 * Bound dirty bursts without postponing refresh indefinitely under continuous updates. The Backend
 * already coalesces dirty (50ms) and throttles stream wakes (200ms), so this only merges the
 * near-simultaneous notices of one change; every extra millisecond here is visible send latency.
 */
export const BACKEND_EVENT_DIRTY_COALESCE_MS = 30;
/** Idle remote polls without a dirty wake: open tabs otherwise hammer full detail projection. */
export const BACKEND_EVENT_IDLE_POLL_MS = 5_000;
/** When Backend dirty events are subscribed, idle safety-net polls can stretch further. */
export const BACKEND_EVENT_DIRTY_IDLE_POLL_MS = 30_000;

type PendingRequests = { permissionRequest: unknown; questionRequest: unknown };
type DetailMessages = "page" | "omit";
type BackendSnapshotRead = [
  Awaited<ReturnType<typeof forwardTaskDetail>>,
  Awaited<ReturnType<typeof forwardTaskPendingRequests>>,
];
type CachedPage = {
  messages: unknown[];
  messageHistory: unknown;
  messageRevision: string;
};

// Share only in-flight reads, never cached state: approvals and rewinds must stay fresh.
// Key includes the message mode so omit/page waiters never share a mismatched response.
const inFlightReads = new Map<string, Promise<BackendSnapshotRead>>();

function readBackendSnapshot(id: string, messages: DetailMessages): Promise<BackendSnapshotRead> {
  // The page size is a live setting, so a read in flight under another size must not be shared.
  const limit = messages === "page" ? readHistoryPageSize() : undefined;
  const key = `${id}:${messages}:${limit ?? ""}`;
  const existing = inFlightReads.get(key);
  if (existing) return existing;
  const read = Promise.allSettled([
    forwardTaskDetail(id, limit === undefined ? { messages } : { messages, limit }),
    forwardTaskPendingRequests(id),
  ])
    .then(([detail, pending]): BackendSnapshotRead => {
      // Keep a rejected read coalesced until its sibling finishes too.
      if (detail.status === "rejected") throw detail.reason;
      if (pending.status === "rejected") throw pending.reason;
      return [detail.value, pending.value];
    })
    .finally(() => { inFlightReads.delete(key); });
  inFlightReads.set(key, read);
  return read;
}

function detailRevision(detail: Record<string, unknown> | null | undefined): string | undefined {
  return typeof detail?.messageRevision === "string" && detail.messageRevision
    ? detail.messageRevision
    : undefined;
}

function cachePageFromDetail(detail: Record<string, unknown> | null): CachedPage | undefined {
  const messageRevision = detailRevision(detail);
  if (!detail || !messageRevision) return undefined;
  const paged = pageTaskDetailMessages(detail, undefined, readHistoryPageSize());
  return {
    messages: paged.messages,
    messageHistory: paged.messageHistory,
    messageRevision,
  };
}

function mergeOmitWithCache(
  detail: Record<string, unknown> | null,
  cache: CachedPage | undefined,
): { detail: Record<string, unknown> | null; needsPage: boolean } {
  if (!detail) return { detail, needsPage: false };
  const revision = detailRevision(detail);
  if (!revision || !cache) return { detail, needsPage: true };
  if (revision !== cache.messageRevision) return { detail, needsPage: true };
  return {
    detail: { ...detail, messages: cache.messages, messageHistory: cache.messageHistory },
    needsPage: false,
  };
}

export type SentMessagePage = { ids: string[]; jsonById: Map<string, string> };

/**
 * Indices of the rows in a new page that the client does not already hold verbatim, or undefined when
 * the page is not "previous page, trimmed at the front, with rows appended at the end". Anything else
 * (re-identified rows, removals in the middle, rewinds) needs a full page.
 */
export function messagePageDelta(
  previous: SentMessagePage,
  ids: readonly string[],
  jsons: readonly string[],
): number[] | undefined {
  if (ids.length === 0 || previous.ids.length === 0) return undefined;
  if (new Set(ids).size !== ids.length) return undefined;
  const start = previous.ids.indexOf(ids[0]!);
  if (start < 0) return undefined;
  const retained = previous.ids.length - start;
  if (ids.length < retained) return undefined;
  const changed: number[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    if (index < retained) {
      if (previous.ids[start + index] !== id) return undefined;
      if (previous.jsonById.get(id) !== jsons[index]) changed.push(index);
    } else {
      // An appended row must be new; an id seen earlier would be a reorder.
      if (previous.jsonById.has(id)) return undefined;
      changed.push(index);
    }
  }
  return changed;
}

/** The task-detail fields that are sent separately, so they are not duplicated inside `task`. */
const DETAIL_ONLY_FIELDS = [
  "messages",
  "messageHistory",
  "isStreaming",
  "isCompacting",
  "contextUsage",
  "compactionSuggested",
  "goalLoop",
  "todos",
  "permissionRequest",
  "questionRequest",
  "manualAbortedAssistantId",
  "hangRetryCount",
  "messageRevision",
] as const;

/** One snapshot payload built from the Backend's detail, in the shape the clients already parse. */
export function backendTaskSnapshot(
  detail: Record<string, unknown> | null,
  pending: { permissionRequest: unknown; questionRequest: unknown },
  extra: Record<string, unknown> = {},
  streamMessages = true,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { ...(detail ?? {}) };
  for (const key of DETAIL_ONLY_FIELDS) delete summary[key];
  const page = streamMessages ? pageTaskDetailMessages(detail, undefined, readHistoryPageSize()) : undefined;
  return {
    type: "snapshot",
    task: summary,
    ...(page ? { messages: page.messages, messageHistory: page.messageHistory } : {}),
    isStreaming: detail?.isStreaming ?? false,
    isCompacting: detail?.isCompacting ?? false,
    contextUsage: detail?.contextUsage,
    compactionSuggested: detail?.compactionSuggested,
    goalLoop: detail?.goalLoop,
    todos: detail?.todos,
    manualAbortedAssistantId: detail?.manualAbortedAssistantId ?? null,
    hangRetryCount: detail?.hangRetryCount ?? 0,
    revertLeafId: detail?.revertLeafId ?? null,
    permissionRequest: pending.permissionRequest,
    questionRequest: pending.questionRequest,
    eventType: "remote_poll",
    ...extra,
  };
}

/**
 * Sends the Backend's snapshot once and polls for changes while the writer is open.
 *
 * Returns `{ ok: false, reason }` when the Backend cannot be read (the caller ends the stream), or
 * `{ ok: true, stop }` where `stop` clears the poll and suppresses in-flight sends. Polls are serialized
 * across ticks; detail and pending reads run concurrently and overlapping viewers share them.
 * The caller registers `stop` as cleanup. Unchanged snapshots are not resent; SSE heartbeats
 * remain the caller's responsibility.
 *
 * `extra` may be a getter so fields this process still owns (the Bot intercom inbox is a local read of
 * shared mailbox files) are re-read for every snapshot instead of being frozen at stream start.
 */
export async function startBackendTaskStream({
  id,
  sse,
  extra = {},
  intervalMs = BACKEND_EVENT_POLL_MS,
  idleIntervalMs = BACKEND_EVENT_IDLE_POLL_MS,
  dirtyIdleIntervalMs = BACKEND_EVENT_DIRTY_IDLE_POLL_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  subscribeDirty = subscribeBackendTaskDirty,
  dirtyConnected = isBackendTaskDirtyConnected,
  messageDelta = false,
  streamDeltas = true,
  streamMessages = true,
}: {
  id: string;
  sse: BackendEventSink;
  extra?: Record<string, unknown> | (() => Record<string, unknown>);
  intervalMs?: number;
  idleIntervalMs?: number;
  dirtyIdleIntervalMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  subscribeDirty?: (taskId: string, listener: (payload?: BackendTaskDirtyPayload) => void) => () => void;
  /** Whether dirty wakes are currently being delivered; the long idle poll requires it. */
  dirtyConnected?: () => boolean;
  /**
   * The client opted in (`delta=1`) to snapshots whose `messages` carry only the changed or appended
   * rows (`messagesDelta: true`). Streaming then costs one message per wake instead of a full page.
   */
  messageDelta?: boolean;
  /** Whether the client accepts high-frequency direct stream wakes; snapshot polling remains active. */
  streamDeltas?: boolean;
  /** Whether snapshots include transcript pages; false keeps only state during hidden-tab connections. */
  streamMessages?: boolean;
}): Promise<{ ok: true; stop: () => void } | { ok: false; reason: string }> {
  const [detail, pending] = await readBackendSnapshot(id, streamMessages ? "page" : "omit");
  if (!detail.ok) return { ok: false, reason: detail.reason };
  let stopped = false;
  let busy = false;
  let dirtyPending = false;
  let dirtyScheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let dirtyAttached = false;
  let cachedPage = streamMessages ? cachePageFromDetail(detail.detail) : undefined;
  let lastStreaming = detail.detail?.isStreaming === true || detail.detail?.isCompacting === true;
  /** Accepted prompt / running turn: poll at the short interval even before the stream opens. */
  const isWorking = (current: Record<string, unknown> | null | undefined) =>
    current?.status === "working" || current?.isStreaming === true || current?.isCompacting === true;
  let lastWorking = isWorking(detail.detail);
  /** Older Backend stream wakes without a delta need a paged read, never an omit probe. */
  let forcePage = false;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeoutImpl(timer);
    timer = undefined;
    wake?.();
    wake = undefined;
  };
  const extraFields = (): Record<string, unknown> => {
    try {
      return (typeof extra === "function" ? extra() : extra) ?? {};
    } catch {
      // A local read behind the extra fields must not take the task snapshot down with it.
      return {};
    }
  };
  let lastSnapshot: string | undefined;
  let lastPending: PendingRequests = pending.ok
    ? { permissionRequest: pending.permissionRequest, questionRequest: pending.questionRequest }
    : { permissionRequest: null, questionRequest: null };
  const resolvePending = (requests: BackendSnapshotRead[1]): PendingRequests => {
    if (!requests.ok) return lastPending;
    lastPending = {
      permissionRequest: requests.permissionRequest,
      questionRequest: requests.questionRequest,
    };
    return lastPending;
  };
  /** Last page actually delivered on this connection; the base for message deltas. */
  let lastPage: SentMessagePage | undefined;
  const sendWithMessageDelta = (snapshot: Record<string, unknown>) => {
    if (!streamMessages) {
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSnapshot) return;
      if (sse.sendSerialized) sse.sendSerialized("snapshot", serialized);
      else sse.send("snapshot", snapshot);
      lastSnapshot = serialized;
      lastPage = undefined;
      return;
    }
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages as Array<{ id?: unknown }> : [];
    const rest: Record<string, unknown> = { ...snapshot };
    delete rest.messages;
    const restJson = JSON.stringify(rest);
    const messageJsons = messages.map((message) => JSON.stringify(message));
    const key = `${restJson}\n${messageJsons.join(",")}`;
    if (key === lastSnapshot) return;
    const ids = messages.map((message) => message?.id);
    const page = ids.every((value): value is string => typeof value === "string")
      ? { ids, jsonById: new Map(ids.map((value, index) => [value, messageJsons[index]!])) }
      : undefined;
    // Deltas only while a turn streams: idle snapshots are rare and carry the full page, so any row a
    // client replaced from a REST read heals at the end of every turn.
    const live = snapshot.isStreaming === true || snapshot.isCompacting === true;
    const changed = live && lastPage && page ? messagePageDelta(lastPage, page.ids, messageJsons) : undefined;
    // restJson is a non-empty object (`type` is always set), so its body can follow the messages.
    const body = changed
      ? `{"messagesDelta":true,"messages":[${changed.map((index) => messageJsons[index]).join(",")}],${restJson.slice(1)}`
      : `{"messages":[${messageJsons.join(",")}],${restJson.slice(1)}`;
    if (sse.sendSerialized) sse.sendSerialized("snapshot", body);
    else sse.send("snapshot", JSON.parse(body));
    lastSnapshot = key;
    lastPage = page;
  };
  const send = (current: Record<string, unknown> | null, requests: BackendSnapshotRead[1]) => {
    if (stopped || sse.closed) return;
    const snapshot = backendTaskSnapshot(current, resolvePending(requests), extraFields(), streamMessages);
    if (messageDelta) {
      sendWithMessageDelta(snapshot);
      lastStreaming = current?.isStreaming === true || current?.isCompacting === true;
      return;
    }
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSnapshot) return;
    if (sse.sendSerialized) sse.sendSerialized("snapshot", serialized);
    else sse.send("snapshot", snapshot);
    lastSnapshot = serialized;
    lastStreaming = current?.isStreaming === true || current?.isCompacting === true;
  };
  const noteState = (current: Record<string, unknown> | null) => {
    lastStreaming = current?.isStreaming === true || current?.isCompacting === true;
    lastWorking = isWorking(current);
  };
  const readNext = async (): Promise<{ detail: Record<string, unknown> | null; pending: BackendSnapshotRead[1] } | null> => {
    const mode: DetailMessages = streamMessages && (lastStreaming || forcePage || !cachedPage) ? "page" : "omit";
    forcePage = false;
    const [next, requests] = await readBackendSnapshot(id, mode);
    if (stopped || sse.closed || !next.ok) return null;
    if (!streamMessages) return { detail: next.detail, pending: requests };
    if (mode === "page") {
      cachedPage = cachePageFromDetail(next.detail) ?? cachedPage;
      return { detail: next.detail, pending: requests };
    }
    const merged = mergeOmitWithCache(next.detail, cachedPage);
    if (!merged.needsPage) return { detail: merged.detail, pending: requests };
    const [full, fullPending] = await readBackendSnapshot(id, "page");
    if (stopped || sse.closed || !full.ok) return null;
    cachedPage = cachePageFromDetail(full.detail) ?? cachedPage;
    return { detail: full.detail, pending: fullPending.ok ? fullPending : requests };
  };
  const pollOnce = async () => {
    if (stopped || sse.closed) {
      stop();
      return;
    }
    if (busy) return;
    busy = true;
    dirtyPending = false;
    try {
      const next = await readNext();
      if (next) {
        // Interval state follows every successful read, not only reads that changed the snapshot.
        noteState(next.detail);
        send(next.detail, next.pending);
      }
    } catch {
      // A transient transport/read failure retries without opening a local session.
    } finally {
      busy = false;
      schedule();
    }
  };
  const schedule = () => {
    if (stopped || sse.closed) {
      stop();
      return;
    }
    if (busy || (dirtyPending && dirtyScheduled && timer !== undefined)) return;
    if (timer !== undefined) clearTimeoutImpl(timer);
    dirtyScheduled = dirtyPending;
    const delay = dirtyPending
      ? BACKEND_EVENT_DIRTY_COALESCE_MS
      : lastStreaming || lastWorking
        ? intervalMs
        : dirtyAttached && dirtyConnectedSafe() ? dirtyIdleIntervalMs : idleIntervalMs;
    timer = setTimeoutImpl(() => {
      timer = undefined;
      dirtyScheduled = false;
      void pollOnce();
    }, delay);
    timer.unref?.();
  };
  const dirtyConnectedSafe = () => {
    try {
      return dirtyConnected();
    } catch {
      return false;
    }
  };
  send(detail.detail, pending);
  if (sse.closed) return { ok: true, stop };
  try {
    wake = subscribeDirty(id, (payload) => {
      if (stopped || sse.closed) return;
      if (payload?.reason === BACKEND_TASK_STREAM_REASON && payload.delta) {
        // The Backend already projected the newest message. Hidden clients can disable this
        // high-frequency path and rely on the independent snapshot poll until they return.
        if (streamDeltas) sse.send("delta", payload.delta);
        if (typeof payload.delta.isStreaming === "boolean" || typeof payload.delta.isCompacting === "boolean") {
          lastStreaming = payload.delta.isStreaming === true || payload.delta.isCompacting === true;
        }
        return;
      }
      // Older Backend bundles send only a wake, so retain the full-page refresh fallback.
      if (payload?.reason === BACKEND_TASK_STREAM_REASON) forcePage = true;
      dirtyPending = true;
      schedule();
    });
    dirtyAttached = true;
  } catch {
    dirtyAttached = false;
    wake = undefined;
  }
  schedule();
  return { ok: true, stop };
}
