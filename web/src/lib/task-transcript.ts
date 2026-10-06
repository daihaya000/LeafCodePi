import { getTaskDetail } from "@/lib/pi/harness";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardTaskDetail } from "@/lib/backend-forward";
import type { UiMessage } from "@/lib/types";

export type TaskTranscriptRead =
  | { ok: true; messages: UiMessage[] }
  | { ok: false; status: number; body: Record<string, unknown> };

const RECENT_LIMIT = 2;
const recentReads = new Map<string, { at: number; read: Promise<TaskTranscriptRead> }>();

/**
 * Every projected message of a task, read the way the history page route reads it: the Backend's
 * detail once it owns the session (never a local fallback), otherwise the transcript on disk without
 * waiting for ensureLive. Message ids therefore match the ids the client pages through.
 *
 * `maxAgeMs` lets a burst of reads (a search refined while typing) share one read of the whole
 * transcript, which can be tens of megabytes. Failures are never kept.
 */
export async function readTaskTranscript(
  id: string,
  { maxAgeMs = 0 }: { maxAgeMs?: number } = {},
): Promise<TaskTranscriptRead> {
  if (maxAgeMs <= 0) return readTranscript(id);
  const now = Date.now();
  const recent = recentReads.get(id);
  if (recent && now - recent.at <= maxAgeMs) return recent.read;
  const read = readTranscript(id);
  recentReads.delete(id);
  recentReads.set(id, { at: now, read });
  while (recentReads.size > RECENT_LIMIT) recentReads.delete(recentReads.keys().next().value as string);
  const forget = () => {
    if (recentReads.get(id)?.read === read) recentReads.delete(id);
  };
  read.then((result) => { if (!result.ok) forget(); }, forget);
  return read;
}

/** Forget reads kept for reuse (tests). */
export function resetTaskTranscriptCache(): void {
  recentReads.clear();
}

async function readTranscript(id: string): Promise<TaskTranscriptRead> {
  if (localRuntimeBlocked()) {
    const forwarded = await forwardTaskDetail(id);
    if (!forwarded.ok) {
      if (forwarded.reason === "not-found") {
        return { ok: false, status: 404, body: { error: "タスクが見つかりません" } };
      }
      if (forwarded.reason === "not-configured") {
        return {
          ok: false,
          status: 409,
          body: { error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" },
        };
      }
      return {
        ok: false,
        status: 502,
        body: { error: "Backendから取得できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
      };
    }
    const messages = forwarded.detail?.messages;
    return { ok: true, messages: Array.isArray(messages) ? messages as UiMessage[] : [] };
  }
  return { ok: true, messages: (await getTaskDetail(id, { offline: true })).messages };
}
