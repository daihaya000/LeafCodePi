import { NextRequest } from "next/server";
import { getTaskDetail, pendingPermissionForTask, subscribeTask } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const detail = await getTaskDetail(id);
        send("snapshot", {
          type: "snapshot",
          task: detail,
          messages: detail.messages,
          isStreaming: detail.isStreaming,
          isCompacting: detail.isCompacting,
          contextUsage: detail.contextUsage,
          goalLoop: detail.goalLoop,
          todos: detail.todos,
          permissionRequest: detail.permissionRequest ?? pendingPermissionForTask(id),
        });
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : String(error) });
        controller.close();
        return;
      }
      unsubscribe = subscribeTask(id, (payload) => send("snapshot", payload));
      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15000);
      req.signal.addEventListener("abort", () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        controller.close();
      });
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
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
