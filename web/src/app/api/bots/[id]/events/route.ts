import { NextRequest } from "next/server";
import { botTaskId } from "@/lib/bots";
import { getBotIntercomInbox, subscribeBotIntercomInbox } from "@/lib/bot-intercom";
import {
  getTaskBootstrap,
  getTaskDetail,
  pendingPermissionForTask,
  pendingQuestionForTask,
  subscribeTask,
} from "@/lib/pi/harness";
import { getTaskDetailBounded } from "@/lib/pi/get-task-detail-bounded";
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
/** Bound ready-path session opens so a hung ensureLive cannot block Bot SSE forever. */
const BOT_SSE_DETAIL_TIMEOUT_MS = 30_000;

function getTaskDetailForBotReady(
  taskId: string,
  options?: Parameters<typeof getTaskDetail>[1],
): Promise<Awaited<ReturnType<typeof getTaskDetail>>> {
  return getTaskDetailBounded(taskId, {
    ...options,
    timeoutMs: BOT_SSE_DETAIL_TIMEOUT_MS,
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const taskId = botTaskId((await params).id);
  const cachedTaskUpdatedAt = req.nextUrl.searchParams.get("cachedTaskUpdatedAt");
  const cachedSessionId = req.nextUrl.searchParams.get("cachedSessionId");
  let sse: ReturnType<typeof createSseWriter> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      let ready = false;
      const pendingPayloads: Record<string, unknown>[] = [];
      const botId = taskId.slice("bot:".length);
      const sub = subscribeTask(taskId, (payload) => {
        const safePayload = pageTaskSnapshotPayload(payload);
        if (!ready) {
          bufferPendingSsePayload(pendingPayloads, safePayload);
          return;
        }
        sse?.send(safePayload.type === "delta" ? "delta" : "snapshot", safePayload);
      });
      const inboxSub = subscribeBotIntercomInbox(botId, (inbox) => {
        if (!ready) return;
        sse?.send("snapshot", { type: "snapshot", eventType: "intercom_inbox", intercomInbox: inbox });
      });
      sse = createSseWriter(controller, { signal: req.signal });
      sse.onCleanup(sub);
      sse.onCleanup(inboxSub);
      sse.startHeartbeat();
      try {
        const bootstrap = getTaskBootstrap(taskId);
        sse.send("snapshot", {
          type: "snapshot",
          task: bootstrap,
          messages: bootstrap.messages,
          isStreaming: bootstrap.isStreaming,
          permissionRequest: pendingPermissionForTask(taskId),
          questionRequest: pendingQuestionForTask(taskId),
          intercomInbox: getBotIntercomInbox(botId),
          eventType: "bootstrap",
        });
        const hasCacheCandidate = Boolean(cachedTaskUpdatedAt && cachedSessionId);
        // Opening a fresh Bot only needs its persisted (empty) transcript. Starting
        // a Pi session here races the first prompt and can leave it waiting behind
        // a stalled cold initialization.
        const coldBootstrap = bootstrap.status !== "working" && !bootstrap.isStreaming && !bootstrap.sessionId;
        const matchesCachedRevision = (candidate: Awaited<ReturnType<typeof getTaskDetail>>) => Boolean(
          cachedTaskUpdatedAt &&
            cachedSessionId &&
            cachedTaskUpdatedAt === candidate.updatedAt &&
            cachedSessionId === candidate.sessionId &&
            candidate.status !== "working" &&
            !candidate.isStreaming &&
            !candidate.isCompacting,
        );
        // An unchanged idle cache already contains the transcript. Release the
        // client before cold Pi setup finishes; the ready snapshot still verifies
        // the revision and supplies the latest controls.
        const canSendCachedReady = Boolean(
          hasCacheCandidate &&
            pendingPayloads.length === 0 &&
            matchesCachedRevision(bootstrap),
        );
        if (canSendCachedReady) {
          sse.send("snapshot", {
            type: "snapshot",
            task: bootstrap,
            messagesReused: true,
            isStreaming: bootstrap.isStreaming,
            isCompacting: false,
            permissionRequest: pendingPermissionForTask(taskId),
            questionRequest: pendingQuestionForTask(taskId),
            intercomInbox: getBotIntercomInbox(botId),
            eventType: "cache_ready",
          });
        }
        const flushReady = (
          detail: Awaited<ReturnType<typeof getTaskDetail>>,
          extra?: { error?: string },
          reuseMessages = false,
        ) => {
          const writer = sse;
          if (!writer || writer.closed) return;
          const page = reuseMessages ? null : pageTaskMessages(detail.messages);
          writer.send("snapshot", {
            type: "snapshot",
            task: { ...detail, messages: undefined },
            ...(reuseMessages
              ? { messagesReused: true }
              : { messages: page!.messages, messageHistory: page!.messageHistory }),
            isStreaming: detail.isStreaming,
            isCompacting: detail.isCompacting,
            ...(detail.contextUsage ? { contextUsage: detail.contextUsage } : {}),
            permissionRequest: pendingPermissionForTask(taskId),
            questionRequest: pendingQuestionForTask(taskId),
            intercomInbox: getBotIntercomInbox(botId),
            eventType: "ready",
            ...(hasCacheCandidate && !reuseMessages ? { historyReset: true } : {}),
            ...(extra?.error ? { error: extra.error } : {}),
          });
          ready = true;
          if (pendingPayloads.length > 0) {
            const readyRank = rankMessageList(page?.messages ?? detail.messages);
            for (const payload of pendingPayloads) {
              if (writer.closed) break;
              const prepared = preparePendingPayloadForReadyFlush(payload, readyRank, detail.updatedAt);
              if (!prepared) continue;
              writer.send(prepared.type === "delta" ? "delta" : "snapshot", prepared);
            }
          }
          pendingPayloads.length = 0;
        };
        // Live ensureLive can fail (unavailable model, etc.). Keep the transcript
        // visible via offline ready instead of closing the stream empty.
        const loadReadyDetail = async () => {
          let detail = await getTaskDetailForBotReady(
            taskId,
            hasCacheCandidate
              ? { includeMessages: false }
              : coldBootstrap
                ? { offline: true }
                : undefined,
          );
          const reuseMessages = hasCacheCandidate && pendingPayloads.length === 0 && matchesCachedRevision(detail);
          if (hasCacheCandidate && !reuseMessages) {
            // A stale cache or buffered event needs the full transcript for correctness.
            detail = await getTaskDetailForBotReady(taskId);
          }
          flushReady(detail, undefined, reuseMessages);
        };
        void loadReadyDetail().catch(async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          try {
            const offline = await getTaskDetail(taskId, { offline: true });
            flushReady(offline, { error: message });
          } catch {
            sse?.send("error", { error: message });
            sse?.close();
          }
        });
      } catch (error) {
        sse.send("error", { error: error instanceof Error ? error.message : String(error) });
        sse.close();
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
      Connection: "keep-alive",
    },
  });
}
