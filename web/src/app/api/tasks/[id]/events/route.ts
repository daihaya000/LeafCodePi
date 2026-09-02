import { NextRequest } from "next/server";
import {
  getTaskBootstrap,
  getTaskDetail,
  pendingPermissionForTask,
  pendingQuestionForTask,
  subscribeTask,
} from "@/lib/pi/harness";
import { createSseWriter } from "@/lib/sse-writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const TASK_SSE_PERF_ENABLED = process.env.NODE_ENV === "development";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
            // Keep the ready snapshot before live updates. A full snapshot
            // supersedes every buffered update; only the latest delta after it
            // can still add information before the stream becomes ready.
            if (payload.type !== "delta") {
              pendingPayloads.length = 0;
              pendingPayloads.push(payload);
            } else {
              const previous = pendingPayloads.at(-1);
              if (previous?.type === "delta") {
                pendingPayloads[pendingPayloads.length - 1] = payload;
              } else {
                pendingPayloads.push(payload);
              }
            }
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
        ]) {
          delete (taskSummary as Record<string, unknown>)[key];
        }
        sse.send("snapshot", {
          type: "snapshot",
          task: taskSummary,
          messages: detail.messages,
          isStreaming: detail.isStreaming,
          isCompacting: detail.isCompacting,
          contextUsage: detail.contextUsage,
          goalLoop: detail.goalLoop,
          todos: detail.todos,
          permissionRequest: detail.permissionRequest ?? pendingPermissionForTask(id),
          questionRequest: detail.questionRequest ?? pendingQuestionForTask(id),
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
        for (const payload of pendingPayloads) {
          if (sse.closed) break;
          sse.send(payload.type === "delta" ? "delta" : "snapshot", payload);
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
