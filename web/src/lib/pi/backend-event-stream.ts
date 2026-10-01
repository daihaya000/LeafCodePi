import { pageTaskDetailMessages } from "@/lib/task-history";
import { forwardTaskDetail, forwardTaskPendingRequests } from "@/lib/backend-forward";

/**
 * The event stream of a task this process does not own.
 *
 * After the cutover the Backend owns the session, so a WebUI stream must be built from the Backend's
 * detail — never from a local subscription or an `ensureLive` — and refreshed by polling. The pending
 * approval/question lives in the owner's memory, so it comes from the Backend's pending snapshots too:
 * without that the approval prompt would never appear after the cutover.
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

type PendingRequests = { permissionRequest: unknown; questionRequest: unknown };
type BackendSnapshotRead = [
  Awaited<ReturnType<typeof forwardTaskDetail>>,
  Awaited<ReturnType<typeof forwardTaskPendingRequests>>,
];
// Share only in-flight reads, never cached state: approvals and rewinds must stay fresh.
// ponytail: coalesces within one Web worker; a Backend event relay would also remove polling.
const inFlightReads = new Map<string, Promise<BackendSnapshotRead>>();

function readBackendSnapshot(id: string): Promise<BackendSnapshotRead> {
  const existing = inFlightReads.get(id);
  if (existing) return existing;
  const read = Promise.allSettled([forwardTaskDetail(id, { messages: "page" }), forwardTaskPendingRequests(id)])
    .then(([detail, pending]): BackendSnapshotRead => {
      // Keep a rejected read coalesced until its sibling finishes too.
      if (detail.status === "rejected") throw detail.reason;
      if (pending.status === "rejected") throw pending.reason;
      return [detail.value, pending.value];
    })
    .finally(() => { inFlightReads.delete(id); });
  inFlightReads.set(id, read);
  return read;
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
] as const;

/** One snapshot payload built from the Backend's detail, in the shape the clients already parse. */
export function backendTaskSnapshot(
  detail: Record<string, unknown> | null,
  pending: { permissionRequest: unknown; questionRequest: unknown },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const summary: Record<string, unknown> = { ...(detail ?? {}) };
  for (const key of DETAIL_ONLY_FIELDS) delete summary[key];
  const page = pageTaskDetailMessages(detail);
  return {
    type: "snapshot",
    task: summary,
    messages: page.messages,
    messageHistory: page.messageHistory,
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
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}: {
  id: string;
  sse: BackendEventSink;
  extra?: Record<string, unknown> | (() => Record<string, unknown>);
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}): Promise<{ ok: true; stop: () => void } | { ok: false; reason: string }> {
  const [detail, pending] = await readBackendSnapshot(id);
  if (!detail.ok) return { ok: false, reason: detail.reason };
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearIntervalImpl(timer);
    timer = undefined;
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
  const send = (current: Record<string, unknown> | null, requests: BackendSnapshotRead[1]) => {
    if (stopped || sse.closed) return;
    const snapshot = backendTaskSnapshot(current, resolvePending(requests), extraFields());
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSnapshot) return;
    if (sse.sendSerialized) sse.sendSerialized("snapshot", serialized);
    else sse.send("snapshot", snapshot);
    lastSnapshot = serialized;
  };
  send(detail.detail, pending);
  if (sse.closed) return { ok: true, stop };
  timer = setIntervalImpl(() => {
    void (async () => {
      if (stopped || sse.closed) {
        stop();
        return;
      }
      if (busy) return;
      busy = true;
      try {
        const [next, requests] = await readBackendSnapshot(id);
        if (!next.ok) return;
        send(next.detail, requests);
      } catch {
        // A transient transport/read failure retries without opening a local session.
      } finally {
        busy = false;
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return { ok: true, stop };
}
