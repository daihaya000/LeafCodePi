import { NextRequest } from "next/server";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const TASK_SSE_PERF_ENABLED = process.env.NODE_ENV === "development";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cachedTaskUpdatedAt = req.nextUrl.searchParams.get("cachedTaskUpdatedAt");
  const cachedSessionId = req.nextUrl.searchParams.get("cachedSessionId");
  let sse: ReturnType<typeof createSseWriter> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      let unsubscribe = () => {};
      let ready = false;
      const pendingPayloads: Record<string, unknown>[] = [];
      const requestStartedAt = TASK_SSE_PERF_ENABLED ? performance.now() : 0;
      sse = createSseWriter(controller);
      sse.onCleanup(() => unsubscribe());
      sse.startHeartbeat();
      try {
        const bootstrapStartedAt = TASK_SSE_PERF_ENABLED ? performance.now() : 0;
        const bootstrap = getTaskBootstrap(id);
        const bootstrapMs = TASK_SSE_PERF_ENABLED
          ? performance.now() - bootstrapStartedAt
          : 0;
        unsubscribe = subscribeTask(id, (payload) => {
          if (!ready) {
            // History snapshots still coalesce, but control events (permission,
            // hang retry, errors) must survive until the ready snapshot flushes.
            bufferPendingSsePayload(pendingPayloads, payload);
            return;
          }
          sse?.send(payload.type === "delta" ? "delta" : "snapshot", payload);
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
        const detail = await getTaskDetail(id);
        if (sse.closed) return;
        const taskSummary = { ...detail };
        for (const key of [
          "messages",
          "isStreaming",
          "isCompacting",
          "contextUsage",
          "goalLoop",
          "todos",
          "permissionRequest",
          "questionRequest",
          "manualAbortedAssistantId",
          "hangRetryCount",
        ]) {
          delete (taskSummary as Record<string, unknown>)[key];
        }
        // An idle cache with the same persisted revision is authoritative enough
        // to skip sending the full history again. Never reuse it while a turn or
        // compaction can still mutate the session.
        const canReuseCachedMessages = Boolean(
          cachedTaskUpdatedAt &&
            cachedSessionId &&
            cachedTaskUpdatedAt === detail.updatedAt &&
            cachedSessionId === detail.sessionId &&
            detail.status !== "working" &&
            !detail.isStreaming &&
            !detail.isCompacting,
        );
        sse.send("snapshot", {
          type: "snapshot",
          task: taskSummary,
          ...(canReuseCachedMessages
            ? { messagesReused: true }
            : { messages: detail.messages }),
          isStreaming: detail.isStreaming,
          isCompacting: detail.isCompacting,
          contextUsage: detail.contextUsage,
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
      } catch (error) {
        sse.send("error", { error: error instanceof Error ? error.message : String(error) });
        sse.close();
        return;
      }
      if (sse.closed) {
        unsubscribe();
        return;
      }
      req.signal.addEventListener("abort", () => sse?.close());
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
