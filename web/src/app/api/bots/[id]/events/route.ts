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
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    getTaskDetail(taskId),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(new Error("タスク詳細の取得がタイムアウトしました"), {
            status: 504,
            timeout: true,
          }),
        );
      }, BOT_SSE_DETAIL_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).catch((error) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "timeout" in error &&
      (error as { timeout?: boolean }).timeout === true
    ) {
      return getTaskDetail(taskId, { offline: true });
    }
    throw error;
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
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
        void getTaskDetailForBotReady(taskId)
          .then((detail) => {
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
          })
          .catch((error) => {
            sse?.send("error", { error: error instanceof Error ? error.message : String(error) });
            sse?.close();
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
