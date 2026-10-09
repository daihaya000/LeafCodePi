type NextRequest = Request & { nextUrl: URL };
import { botTaskId } from "@/lib/bots";

import {
  getTaskBootstrap,
  getTaskDetail,
  pendingPermissionForTask,
  pendingQuestionForTask,

} from "@/lib/pi/harness";

import { createIndividualWriter as createSseWriter, bufferIndividualPending as bufferPendingSsePayload, readIndividualDetail as getTaskDetailBounded, subscribeIndividualTask as subscribeTask, subscribeIndividualInbox as subscribeBotIntercomInbox, readIndividualInbox as getBotIntercomInbox, startIndividualPoll } from "../../individual-state";
import { sseResponse } from "../../individual-state";
import { readHistoryPageSize } from "@/lib/pi/history-page-size";


import {

  preparePendingPayloadForReadyFlush,
  rankMessageList,
} from "@/lib/sse-ready-buffer";
import {
  pageTaskMessages,
  pageTaskSnapshotPayload,
} from "@/lib/task-history";
import { createBotSseSnapshotDeduper } from "@/lib/bot-sse-snapshot";

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
      void (async () => {
      sse = createSseWriter(controller, { signal: req.signal });
      let ready = false;
      const pendingPayloads: Record<string, unknown>[] = [];
      const prepareSnapshot = createBotSseSnapshotDeduper();
      const sendBotSnapshot = (payload: Record<string, unknown>) => {
        const writer = sse;
        if (!writer || writer.closed || !writer.validate(payload)) return;
        const prepared = prepareSnapshot(payload);
        writer.send("snapshot", prepared.payload);
        prepared.commit();
      };
      const botId = taskId.slice("bot:".length);
      const sub = subscribeTask(taskId, (payload) => {
        const safePayload = pageTaskSnapshotPayload(payload, readHistoryPageSize());
        if (!ready) {
          bufferPendingSsePayload(pendingPayloads, safePayload, sse!);
          return;
        }
        if (safePayload.type === "delta") sse?.send("delta", safePayload);
        else sendBotSnapshot(safePayload);
      });
      sse.onCleanup(sub);
      const inboxSub = subscribeBotIntercomInbox(botId, (inbox) => {
        if (!ready) return;
        sendBotSnapshot({ type: "snapshot", eventType: "intercom_inbox", intercomInbox: inbox });
      });
      sse.onCleanup(inboxSub);
      startIndividualPoll(() => { if (!ready || sse!.closed) return; try { sendBotSnapshot({ type: "snapshot", eventType: "intercom_inbox", intercomInbox: getBotIntercomInbox(botId) }); } catch { sse!.close(); } }, sse);
      sse.startHeartbeat();
      try {
        // Session events and shared mailbox reads both belong to this owner.

        const bootstrap = getTaskBootstrap(taskId);
        sendBotSnapshot({
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
          sendBotSnapshot({
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
          const page = reuseMessages ? null : pageTaskMessages(detail.messages, undefined, readHistoryPageSize());
          sendBotSnapshot({
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
              if (prepared.type === "delta") writer.send("delta", prepared);
              else sendBotSnapshot(prepared);
            }
          }
          writer.releasePending(pendingPayloads);
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
            const offline = await getTaskDetailBounded(taskId, { offline: true });
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
      })().catch(() => sse?.close());
    },
    pull() { sse?.pull(); },
    cancel() { sse?.cleanup(); },
  }, { highWaterMark: 0 });
  return sseResponse(req.headers.get("accept-encoding"), stream);
}
