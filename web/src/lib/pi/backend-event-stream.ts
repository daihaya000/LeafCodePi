import { pageTaskMessages } from "@/lib/task-history";
import { forwardTaskDetail, forwardTaskPendingRequests } from "@/lib/backend-forward";

/**
 * The event stream of a task this process does not own.
 *
 * After the cutover the Backend owns the session, so a WebUI stream must be built from the Backend's
 * detail — never from a local subscription or an `ensureLive` — and refreshed by polling. The pending
 * approval/question lives in the owner's memory, so it comes from the Backend's pending snapshots too:
 * without that the approval prompt would never appear after the cutover.
 *
 * A failed read is reported to the caller, which ends the stream with an error; falling back to the
 * in-process session would report a state this process does not own.
 */

/** What the helper needs from an SSE writer; `createSseWriter` satisfies it. */
export type BackendEventSink = {
  send(event: string, payload: unknown): void;
  readonly closed: boolean;
};

export const BACKEND_EVENT_POLL_MS = 2_000;

/** The task-detail fields that are sent separately, so they are not duplicated inside `task`. */
const DETAIL_ONLY_FIELDS = [
  "messages",
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
  const messages = Array.isArray(detail?.messages)
    ? (detail.messages as Parameters<typeof pageTaskMessages>[0])
    : [];
  const page = pageTaskMessages(messages);
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
 * Sends the Backend's snapshot once and keeps polling while the writer is open.
 *
 * Returns `{ ok: false, reason }` when the Backend cannot be read (the caller ends the stream), or
 * `{ ok: true, stop }` where `stop` clears the poll — the caller registers it as cleanup.
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
  extra?: Record<string, unknown>;
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}): Promise<{ ok: true; stop: () => void } | { ok: false; reason: string }> {
  const detail = await forwardTaskDetail(id);
  if (!detail.ok) return { ok: false, reason: detail.reason };
  const send = async (current: Record<string, unknown> | null) => {
    const pending = await forwardTaskPendingRequests(id);
    if (sse.closed) return;
    sse.send("snapshot", backendTaskSnapshot(current, pending, extra));
  };
  await send(detail.detail);
  if (sse.closed) return { ok: true, stop: () => {} };
  const timer = setIntervalImpl(() => {
    void (async () => {
      if (sse.closed) {
        clearIntervalImpl(timer);
        return;
      }
      const next = await forwardTaskDetail(id);
      if (!next.ok || sse.closed) return;
      await send(next.detail);
    })();
  }, intervalMs);
  timer.unref?.();
  return { ok: true, stop: () => clearIntervalImpl(timer) };
}
