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
import { sseResponse } from "@/lib/sse-response";
import {
  bufferPendingSsePayload,
  preparePendingPayloadForReadyFlush,
  rankMessageList,
} from "@/lib/sse-ready-buffer";
import {
  pageTaskMessages,
  pageTaskSnapshotPayload,
} from "@/lib/task-history";
import { readHistoryPageSize } from "@/lib/pi/history-page-size";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import {
  BACKEND_EVENT_STREAMING_POLL_MS,
  messagePageDelta,
  startBackendTaskStream,
  type SentMessagePage,
} from "@/lib/pi/backend-event-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const TASK_SSE_PERF_ENABLED = process.env.NODE_ENV === "development";
/** Bound ready-path session opens so a hung ensureLive cannot block SSE forever. */
const TASK_SSE_DETAIL_TIMEOUT_MS = 30_000;
const REMOTE_TASK_POLL_BASE_MS = 2_000;
const REMOTE_TASK_POLL_MAX_MS = 10_000;

function omitTaskMessagePayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.eventType === "agent_settled") return payload;
  const result = { ...payload };
  delete result.message;
  delete result.messages;
  delete result.messagesDelta;
  delete result.messageHistory;
  delete result.historyReset;
  return result;
}

/** Non-transcript fields used to detect meaningful foreign-owner state changes. */
function remotePollStateSignature(
  taskSummary: Record<string, unknown>,
  detail: { isStreaming?: boolean; isCompacting?: boolean; contextUsage?: unknown; hangRetryCount?: number },
): string {
  return [
    String(taskSummary.updatedAt ?? ""),
    String(taskSummary.sessionId ?? ""),
    String(taskSummary.status ?? ""),
    String(detail.isStreaming ?? ""),
    String(detail.isCompacting ?? ""),
    JSON.stringify(detail.contextUsage ?? null),
    String(detail.hangRetryCount ?? 0),
  ].join(":");
}

/**
 * Change key for the foreign-owner poll. Task writes bump `updatedAt`, and the
 * message count plus last message id cover sub-millisecond appends.
 */
function remotePollSignature(
  taskSummary: Record<string, unknown>,
  detail: { isStreaming?: boolean; isCompacting?: boolean; contextUsage?: unknown; hangRetryCount?: number },
  messageCount: number,
  lastMessageId: string,
): string {
  return `${remotePollStateSignature(taskSummary, detail)}:${messageCount}:${lastMessageId}`;
}

function serializeRemoteMessages(messages: readonly { id: string }[]): { page: SentMessagePage; jsons: string[] } {
  const ids = messages.map((message) => message.id);
  const jsons = messages.map((message) => JSON.stringify(message));
  return {
    page: { ids, jsonById: new Map(ids.map((id, index) => [id, jsons[index]!])) },
    jsons,
  };
}

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
  const messageDelta = req.nextUrl.searchParams.get("delta") === "1";
  const streamDeltas = req.nextUrl.searchParams.get("streamDeltas") !== "0";
  const streamMessages = req.nextUrl.searchParams.get("streamMessages") !== "0";
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
      let remotePollTimer: ReturnType<typeof setTimeout> | undefined;
      let remotePollBusy = false;
      let remotePollStopped = false;
      let unchangedRemotePolls = 0;
      /** Last remote snapshot signature, so an unchanged poll costs no send. */
      let lastRemoteSignature: string | undefined;
      const stopRemotePoll = () => {
        remotePollStopped = true;
        if (remotePollTimer) clearTimeout(remotePollTimer);
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
      let lastSentTaskSummaryJson: string | undefined;
      const sendTaskAwareSnapshot = (event: string, payload: Record<string, unknown>) => {
        const writer = sse;
        if (!writer || writer.closed) return;
        const task = payload.task;
        if (event !== "snapshot" || !task || typeof task !== "object") {
          writer.send(event, payload);
          return;
        }
        const taskSummaryJson = JSON.stringify(task);
        if (taskSummaryJson === lastSentTaskSummaryJson) {
          const reusedPayload: Record<string, unknown> = { ...payload, taskReused: true };
          delete reusedPayload.task;
          writer.send(event, reusedPayload);
          return;
        }
        writer.send(event, payload);
        lastSentTaskSummaryJson = taskSummaryJson;
      };
      try {
        // After the cutover the Backend owns the session: this process must not subscribe to (or open)
        // a session it does not own, so the stream is built from the Backend's detail and polled.
        if (localRuntimeBlocked()) {
          const backendStream = await startBackendTaskStream({
            id,
            sse,
            messageDelta,
            streamDeltas,
            streamMessages,
            streamingIntervalMs: BACKEND_EVENT_STREAMING_POLL_MS,
          });
          if (!backendStream.ok) {
            sse.send("error", {
              error: backendStream.reason === "not-found" ? "タスクが見つかりません" : "Backendから取得できません",
              reason: backendStream.reason,
            });
            sse.close();
            return;
          }
          sse.onCleanup(backendStream.stop);
          return;
        }
        const bootstrapStartedAt = TASK_SSE_PERF_ENABLED ? performance.now() : 0;
        const bootstrap = getTaskBootstrap(id);
        const bootstrapMs = TASK_SSE_PERF_ENABLED
          ? performance.now() - bootstrapStartedAt
          : 0;
        unsubscribe = subscribeTask(id, (payload) => {
          if (!streamDeltas && payload.type === "delta") return;
          const sourcePayload = streamMessages ? payload : omitTaskMessagePayload(payload);
          const safePayload = pageTaskSnapshotPayload(sourcePayload, readHistoryPageSize());
          if (!ready) {
            // History snapshots still coalesce, but control events (permission,
            // hang retry, errors) must survive until the ready snapshot flushes.
            bufferPendingSsePayload(pendingPayloads, safePayload);
            return;
          }
          sendTaskAwareSnapshot(safePayload.type === "delta" ? "delta" : "snapshot", safePayload);
        });
        // createSseWriter closes immediately for an already-aborted request, so
        // its earlier cleanup callback cannot see this newly-created subscription.
        if (sse.closed) {
          unsubscribe();
          return;
        }
        const bootstrapPayload = {
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
        };
        sendTaskAwareSnapshot("snapshot", streamMessages ? bootstrapPayload : omitTaskMessagePayload(bootstrapPayload));
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
          sendTaskAwareSnapshot("snapshot", {
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
          ...(!streamMessages || (hasCacheCandidate && !cachedSilentResumeCandidate)
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
            ? await getTaskDetailForReady(id, { ...(!streamMessages ? { includeMessages: false } : {}), onTiming: reportTiming })
            : await getTaskDetailForReady(id, !streamMessages ? { includeMessages: false } : undefined);
          if (sse.closed) return;
          canReuseCachedMessages = matchesCachedRevision(detail);
        }
        const messagePage = streamMessages
          ? pageTaskMessages(detail.messages, undefined, readHistoryPageSize())
          : undefined;
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
        const readyPayload = {
          type: "snapshot",
          task: taskSummary,
          ...(canReuseCachedMessages
            ? { messagesReused: true }
            : messagePage
              ? { messages: messagePage.messages, messageHistory: messagePage.messageHistory }
              : {}),
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
        };
        sendTaskAwareSnapshot("snapshot", streamMessages ? readyPayload : omitTaskMessagePayload(readyPayload));
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
            const prepared = preparePendingPayloadForReadyFlush(payload, readyRank, detail.updatedAt);
            if (!prepared) continue;
            sendTaskAwareSnapshot(prepared.type === "delta" ? "delta" : "snapshot", prepared);
          }
        }
        pendingPayloads.length = 0;

        if (isTaskRuntimeOwnedElsewhere(getTask(id) ?? bootstrap)) {
          const writer = sse!;
          // Ready already delivered this revision/page; don't echo it on the first unchanged poll.
          lastRemoteSignature = remotePollSignature(
            taskSummary,
            detail,
            messagePage?.messages.length ?? detail.messages.length,
            messagePage?.messages.at(-1)?.id ?? "",
          );
          let lastRemoteStateSignature = remotePollStateSignature(taskSummary, detail);
          let reuseCachedRemotePage = messageDelta && streamMessages && canReuseCachedMessages;
          let lastRemotePage = messageDelta && messagePage
            ? serializeRemoteMessages(messagePage.messages).page
            : undefined;
          const scheduleRemotePoll = (delayMs: number) => {
            if (remotePollStopped || writer.closed) return;
            remotePollTimer = setTimeout(() => {
              remotePollTimer = undefined;
              void pollRemoteTask();
            }, delayMs);
            remotePollTimer.unref?.();
          };
          const pollRemoteTask = async () => {
            if (remotePollBusy || writer.closed) return;
            remotePollBusy = true;
            let nextPollDelayMs = REMOTE_TASK_POLL_BASE_MS;
            try {
              const task = getTask(id);
              if (!task) {
                stopRemotePoll();
                return;
              }
              const detail = await getTaskDetailBounded(id, {
                offline: true,
                ...(!streamMessages ? { includeMessages: false } : {}),
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
              const messagePage = streamMessages
                ? pageTaskMessages(detail.messages, undefined, readHistoryPageSize())
                : undefined;
              // Keep active foreign tasks responsive, then back off unchanged details up to
              // 10s. Skip byte-identical snapshots so idle remote sessions cost fewer reads and no SSE traffic.
              const signature = remotePollSignature(
                taskSummary,
                detail,
                messagePage?.messages.length ?? detail.messages.length,
                messagePage?.messages.at(-1)?.id ?? "",
              );
              const stateSignature = remotePollStateSignature(taskSummary, detail);
              const signatureChanged = signature !== lastRemoteSignature;
              const cachedPageStillValid = reuseCachedRemotePage &&
                cachedTaskUpdatedAt === detail.updatedAt &&
                cachedSessionId === detail.sessionId &&
                detail.status !== "working" && !detail.isStreaming && !detail.isCompacting;
              const serializedPage = signatureChanged && messageDelta && messagePage
                ? serializeRemoteMessages(messagePage.messages)
                : undefined;
              const changedMessageIndexes = lastRemotePage && serializedPage
                ? messagePageDelta(lastRemotePage, serializedPage.page.ids, serializedPage.jsons)
                : undefined;
              let shouldSendSnapshot = false;
              let remoteMessages: Record<string, unknown> = {};
              if (cachedPageStillValid) {
                if (signatureChanged) {
                  lastRemoteSignature = signature;
                  lastRemotePage = serializedPage?.page;
                }
                const stateChanged = stateSignature !== lastRemoteStateSignature;
                lastRemoteStateSignature = stateSignature;
                shouldSendSnapshot = stateChanged;
                if (messagePage) {
                  remoteMessages = {
                    messagesDelta: true,
                    messages: [],
                    messageHistory: messagePage.messageHistory,
                  };
                }
                if (stateChanged) unchangedRemotePolls = 0;
                else {
                  unchangedRemotePolls = Math.min(unchangedRemotePolls + 1, 3);
                  nextPollDelayMs = Math.min(
                    REMOTE_TASK_POLL_MAX_MS,
                    REMOTE_TASK_POLL_BASE_MS * 2 ** unchangedRemotePolls,
                  );
                }
              } else {
                reuseCachedRemotePage = false;
                if (signatureChanged) {
                  lastRemoteSignature = signature;
                  lastRemoteStateSignature = stateSignature;
                  lastRemotePage = serializedPage?.page;
                  unchangedRemotePolls = 0;
                  shouldSendSnapshot = true;
                  remoteMessages = messagePage
                    ? changedMessageIndexes !== undefined
                      ? {
                          messagesDelta: true,
                          messages: changedMessageIndexes.map((index) => messagePage.messages[index]!),
                          messageHistory: messagePage.messageHistory,
                        }
                      : { messages: messagePage.messages, messageHistory: messagePage.messageHistory }
                    : {};
                } else {
                  unchangedRemotePolls = Math.min(unchangedRemotePolls + 1, 3);
                  nextPollDelayMs = Math.min(
                    REMOTE_TASK_POLL_MAX_MS,
                    REMOTE_TASK_POLL_BASE_MS * 2 ** unchangedRemotePolls,
                  );
                }
              }
              if (shouldSendSnapshot) {
                // Offline detail always nulls permission/question. Omit them so a buffered
                // live control event (or local pending at ready) is not wiped by remote polls.
                sendTaskAwareSnapshot("snapshot", {
                  type: "snapshot",
                  task: taskSummary,
                  ...remoteMessages,
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
              }
              if (!isTaskRuntimeOwnedElsewhere(getTask(id) ?? task)) stopRemotePoll();
            } catch {
              // The owner may be replacing the append-only session file; the next poll retries.
            } finally {
              remotePollBusy = false;
              if (!remotePollStopped && !writer.closed) scheduleRemotePoll(nextPollDelayMs);
            }
          };
          scheduleRemotePoll(REMOTE_TASK_POLL_BASE_MS);
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

  return sseResponse(req.headers.get("accept-encoding"), stream, { Pragma: "no-cache", Expires: "0" });
}
