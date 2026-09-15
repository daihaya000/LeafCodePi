import { NextRequest } from "next/server";
import {
  getTaskBootstrap,
  getTaskDetail,
  isTaskRuntimeOwnedElsewhere,
  pendingPermissionForTask,
  pendingQuestionForTask,
  subscribeTask,
} from "@/lib/pi/harness";
import { getTaskDetailBounded } from "@/lib/pi/get-task-detail-bounded";
import { getTask } from "@/lib/store";
import { createSseWriter } from "@/lib/sse-writer";
import {
  bufferPendingSsePayload,
  preparePendingPayloadForReadyFlush,
  rankMessageList,
} from "@/lib/sse-ready-buffer";
import {
  pageTaskMessages,
  pageTaskSnapshotPayload,
} from "@/lib/task-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const TASK_SSE_PERF_ENABLED = process.env.NODE_ENV === "development";
/** Bound ready-path session opens so a hung ensureLive cannot block SSE forever. */
const TASK_SSE_DETAIL_TIMEOUT_MS = 30_000;

async function getTaskDetailForReady(
  id: string,
  options?: Parameters<typeof getTaskDetail>[1],
): Promise<Awaited<ReturnType<typeof getTaskDetail>>> {
  return getTaskDetailBounded(id, {
    ...options,
    timeoutMs: TASK_SSE_DETAIL_TIMEOUT_MS,
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cachedTaskUpdatedAt = req.nextUrl.searchParams.get("cachedTaskUpdatedAt");
  const cachedSessionId = req.nextUrl.searchParams.get("cachedSessionId");
  const cachedSilentResumeCandidate =
    req.nextUrl.searchParams.get("cachedSilentResumeCandidate") === "1";
  const perfRequested = req.nextUrl.searchParams.get("perf") === "1";
  const serverTimings: { phase: string; durationMs: number }[] = [];
  const transportTimings: { phase: string; durationMs: number }[] = [];
  const reportTiming = perfRequested
    ? (timing: { phase: string; durationMs: number }) => serverTimings.push(timing)
    : undefined;
  const reportTransportTiming = perfRequested
    ? (timing: { phase: string; durationMs: number }) => transportTimings.push(timing)
    : undefined;
  let sse: ReturnType<typeof createSseWriter> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      let unsubscribe = () => {};
      let remotePollTimer: ReturnType<typeof setInterval> | undefined;
      let remotePollBusy = false;
      const stopRemotePoll = () => {
        if (remotePollTimer) clearInterval(remotePollTimer);
        remotePollTimer = undefined;
      };
      let ready = false;
      const pendingPayloads: Record<string, unknown>[] = [];
      const requestStartedAt = TASK_SSE_PERF_ENABLED ? performance.now() : 0;
      sse = createSseWriter(controller, {
        ...(reportTransportTiming ? { onTiming: reportTransportTiming } : {}),
        signal: req.signal,
      });
      sse.onCleanup(() => {
        unsubscribe();
        stopRemotePoll();
      });
      sse.startHeartbeat();
      try {
        const bootstrapStartedAt = TASK_SSE_PERF_ENABLED ? performance.now() : 0;
        const bootstrap = getTaskBootstrap(id);
        const bootstrapMs = TASK_SSE_PERF_ENABLED
          ? performance.now() - bootstrapStartedAt
          : 0;
        unsubscribe = subscribeTask(id, (payload) => {
          const safePayload = pageTaskSnapshotPayload(payload);
          if (!ready) {
            // History snapshots still coalesce, but control events (permission,
            // hang retry, errors) must survive until the ready snapshot flushes.
            bufferPendingSsePayload(pendingPayloads, safePayload);
            return;
          }
          sse?.send(safePayload.type === "delta" ? "delta" : "snapshot", safePayload);
        });
        sse.send("snapshot", {
          type: "snapshot",
          task: bootstrap,
          messages: bootstrap.messages,
          isStreaming: bootstrap.isStreaming,
          isCompacting: bootstrap.isCompacting,
          permissionRequest: pendingPermissionForTask(id),
          questionRequest: pendingQuestionForTask(id),
          manualAbortedAssistantId: bootstrap.manualAbortedAssistantId ?? null,
          hangRetryCount: bootstrap.hangRetryCount ?? 0,
          revertLeafId: bootstrap.revertLeafId ?? null,
          eventType: "bootstrap",
        });
        if (sse.closed) return;
        const hasCacheCandidate = Boolean(cachedTaskUpdatedAt && cachedSessionId);
        // A matching idle cache can render while cold Pi setup finishes. Keep
        // this interim snapshot distinct; the client stays gated until ready.
        const canSendCachedReady = Boolean(
          hasCacheCandidate &&
            pendingPayloads.length === 0 &&
            cachedTaskUpdatedAt === bootstrap.updatedAt &&
            cachedSessionId === bootstrap.sessionId &&
            bootstrap.status !== "working" &&
            !bootstrap.isStreaming &&
            !bootstrap.isCompacting,
        );
        if (canSendCachedReady) {
          sse.send("snapshot", {
            type: "snapshot",
            task: bootstrap,
            messagesReused: true,
            isStreaming: bootstrap.isStreaming,
            isCompacting: bootstrap.isCompacting,
            permissionRequest: pendingPermissionForTask(id),
            questionRequest: pendingQuestionForTask(id),
            manualAbortedAssistantId: bootstrap.manualAbortedAssistantId ?? null,
            hangRetryCount: bootstrap.hangRetryCount ?? 0,
            revertLeafId: bootstrap.revertLeafId ?? null,
            eventType: "cache_ready",
          });
        }
        let detail = await getTaskDetailForReady(id, {
          ...(hasCacheCandidate && !cachedSilentResumeCandidate
            ? { includeMessages: false }
            : {}),
          ...(reportTiming ? { onTiming: reportTiming } : {}),
        });
        if (sse.closed) return;
        const matchesCachedRevision = (candidate: typeof detail) =>
          Boolean(
            cachedTaskUpdatedAt &&
              cachedSessionId &&
              cachedTaskUpdatedAt === candidate.updatedAt &&
              cachedSessionId === candidate.sessionId &&
              candidate.status !== "working" &&
              !candidate.isStreaming &&
              !candidate.isCompacting,
          );
        let canReuseCachedMessages =
          !cachedSilentResumeCandidate && matchesCachedRevision(detail);
        if (
          hasCacheCandidate &&
          !cachedSilentResumeCandidate &&
          (!canReuseCachedMessages || pendingPayloads.length > 0)
        ) {
          // A stale cache or buffered event needs the full server history for
          // correctness; stable idle cache hits keep the expensive projection
          // out of the ready path.
          detail = reportTiming
            ? await getTaskDetailForReady(id, { onTiming: reportTiming })
            : await getTaskDetailForReady(id);
          if (sse.closed) return;
          canReuseCachedMessages = matchesCachedRevision(detail);
        }
        const messagePage = pageTaskMessages(detail.messages);
        const taskSummary = { ...detail };
        for (const key of [
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
        ]) {
          delete (taskSummary as Record<string, unknown>)[key];
        }
        sse.send("snapshot", {
          type: "snapshot",
          task: taskSummary,
          ...(canReuseCachedMessages
            ? { messagesReused: true }
            : { messages: messagePage.messages, messageHistory: messagePage.messageHistory }),
          ...(hasCacheCandidate && !canReuseCachedMessages ? { historyReset: true } : {}),
          ...(perfRequested ? { serverTiming: serverTimings } : {}),
          isStreaming: detail.isStreaming,
          isCompacting: detail.isCompacting,
          contextUsage: detail.contextUsage,
          compactionSuggested: detail.compactionSuggested,
          goalLoop: detail.goalLoop,
          todos: detail.todos,
          // Prefer live pending at send time (same as bootstrap). Detail may be
          // stale if the user answered while getTaskDetail was in flight.
          permissionRequest: pendingPermissionForTask(id),
          questionRequest: pendingQuestionForTask(id),
          manualAbortedAssistantId: detail.manualAbortedAssistantId ?? null,
          hangRetryCount: detail.hangRetryCount ?? 0,
          revertLeafId: detail.revertLeafId ?? null,
          eventType: "ready",
        });
        if (perfRequested) {
          sse.send("perf", {
            type: "perf",
            eventType: "perf",
            serverTiming: [...serverTimings, ...transportTimings],
          });
        }
        if (TASK_SSE_PERF_ENABLED) {
          console.debug("[leafcodepi:sse-perf]", {
            bootstrapMs: Math.round(bootstrapMs),
            readyMs: Math.round(performance.now() - requestStartedAt),
            messages: detail.messages.length,
            bufferedPayloads: pendingPayloads.length,
          });
        }
        ready = true;
        if (pendingPayloads.length > 0) {
          // No buffered payload means there is no history to compare. Avoid
          // serializing the full ready history just to build an unused rank.
          const readyRank = rankMessageList(detail.messages);
          for (const payload of pendingPayloads) {
            if (sse.closed) break;
            // Ready is authoritative for full history. Only flush buffered
            // events that are still newer so an older mid-fetch snapshot cannot
            // rewind the client after ready. Control events still flush, but
            // stale embedded messages are stripped.
            const prepared = preparePendingPayloadForReadyFlush(payload, readyRank);
            if (!prepared) continue;
            sse.send(prepared.type === "delta" ? "delta" : "snapshot", prepared);
          }
        }
        pendingPayloads.length = 0;

        if (isTaskRuntimeOwnedElsewhere(getTask(id) ?? bootstrap)) {
          const writer = sse!;
          const pollRemoteTask = async () => {
            if (remotePollBusy || writer.closed) return;
            remotePollBusy = true;
            try {
              const task = getTask(id);
              if (!task) {
                stopRemotePoll();
                return;
              }
              const detail = await getTaskDetailBounded(id, {
                offline: true,
                timeoutMs: 10_000,
              });
              if (writer.closed) return;
              const taskSummary = { ...detail };
              for (const key of [
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
              ]) {
                delete (taskSummary as Record<string, unknown>)[key];
              }
              const messagePage = pageTaskMessages(detail.messages);
              // offline detail always nulls permission/question. Omit them so a
              // buffered live control event (or local pending at ready) is not
              // wiped every 2s while another worker holds the lease.
              writer.send("snapshot", {
                type: "snapshot",
                task: taskSummary,
                messages: messagePage.messages,
                messageHistory: messagePage.messageHistory,
                isStreaming: detail.isStreaming,
                isCompacting: detail.isCompacting,
                contextUsage: detail.contextUsage,
                compactionSuggested: detail.compactionSuggested,
                goalLoop: detail.goalLoop,
                todos: detail.todos,
                manualAbortedAssistantId: detail.manualAbortedAssistantId ?? null,
                hangRetryCount: detail.hangRetryCount ?? 0,
                revertLeafId: detail.revertLeafId ?? null,
                eventType: "remote_poll",
              });
              if (!isTaskRuntimeOwnedElsewhere(getTask(id) ?? task)) stopRemotePoll();
            } catch {
              // The owner may be replacing the append-only session file; the next poll retries.
            } finally {
              remotePollBusy = false;
            }
          };
          remotePollTimer = setInterval(() => void pollRemoteTask(), 2_000);
          remotePollTimer.unref?.();
        }
      } catch (error) {
        sse.send("error", { error: error instanceof Error ? error.message : String(error) });
        sse.close();
        return;
      }
      if (sse.closed) {
        unsubscribe();
        return;
      }
    },
    cancel() {
      sse?.cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, no-transform",
      Pragma: "no-cache",
      Expires: "0",
      Connection: "keep-alive",
    },
  });
}
