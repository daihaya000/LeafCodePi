import { NextRequest } from "next/server";
import { getTaskDetail, pendingPermissionForTask, pendingQuestionForTask, subscribeTask } from "@/lib/pi/harness";
import { createSseWriter } from "@/lib/sse-writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let sse: ReturnType<typeof createSseWriter> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      let unsubscribe = () => {};
      sse = createSseWriter(controller);
      sse.onCleanup(() => unsubscribe());
      try {
        const detail = await getTaskDetail(id);
        if (sse.closed) return;
        sse.send("snapshot", {
          type: "snapshot",
          task: detail,
          messages: detail.messages,
          isStreaming: detail.isStreaming,
          isCompacting: detail.isCompacting,
          contextUsage: detail.contextUsage,
          goalLoop: detail.goalLoop,
          todos: detail.todos,
          permissionRequest: detail.permissionRequest ?? pendingPermissionForTask(id),
          questionRequest: detail.questionRequest ?? pendingQuestionForTask(id),
        });
      } catch (error) {
        sse.send("error", { error: error instanceof Error ? error.message : String(error) });
        sse.close();
        return;
      }
      unsubscribe = subscribeTask(id, (payload) => sse?.send("snapshot", payload));
      if (sse.closed) {
        unsubscribe();
        return;
      }
      sse.startHeartbeat();
      req.signal.addEventListener("abort", () => sse?.close());
    },
    cancel() {
      sse?.cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
