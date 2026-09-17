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

function getTaskDetailForBotReady(taskId: string): Promise<Awaited<ReturnType<typeof getTaskDetail>>> {
  return getTaskDetailBounded(taskId, { timeoutMs: BOT_SSE_DETAIL_TIMEOUT_MS });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const taskId = botTaskId((await params).id);
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
        const flushReady = (
          detail: Awaited<ReturnType<typeof getTaskDetail>>,
          extra?: { error?: string },
        ) => {
          const writer = sse;
          if (!writer || writer.closed) return;
          const page = pageTaskMessages(detail.messages);
          writer.send("snapshot", {
            type: "snapshot",
            task: { ...detail, messages: undefined },
            messages: page.messages,
            messageHistory: page.messageHistory,
            isStreaming: detail.isStreaming,
            permissionRequest: pendingPermissionForTask(taskId),
            questionRequest: pendingQuestionForTask(taskId),
            intercomInbox: getBotIntercomInbox(botId),
            eventType: "ready",
            ...(extra?.error ? { error: extra.error } : {}),
          });
          ready = true;
          const readyRank = rankMessageList(page.messages);
          for (const payload of pendingPayloads) {
            if (writer.closed) break;
            const prepared = preparePendingPayloadForReadyFlush(payload, readyRank);
            if (!prepared) continue;
            writer.send(prepared.type === "delta" ? "delta" : "snapshot", prepared);
          }
          pendingPayloads.length = 0;
        };
        // Live ensureLive can fail (unavailable model, etc.). Keep the transcript
        // visible via offline ready instead of closing the stream empty.
        void getTaskDetailForBotReady(taskId)
          .then((detail) => flushReady(detail))
          .catch(async (error) => {
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
