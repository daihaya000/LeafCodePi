import { NextRequest } from "next/server";
import { botTaskId } from "@/lib/bots";
import { getTaskBootstrap, getTaskDetail, pendingPermissionForTask, pendingQuestionForTask, subscribeTask } from "@/lib/pi/harness";
import { createSseWriter } from "@/lib/sse-writer";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const taskId = botTaskId((await params).id); let sse: ReturnType<typeof createSseWriter> | undefined;
  const stream = new ReadableStream({ start(controller) { const sub = subscribeTask(taskId, (payload) => sse?.send(payload.type === "delta" ? "delta" : "snapshot", payload)); sse = createSseWriter(controller); sse.onCleanup(sub); sse.startHeartbeat(); try { const b = getTaskBootstrap(taskId); sse.send("snapshot", { type: "snapshot", task: b, messages: b.messages, isStreaming: b.isStreaming, permissionRequest: pendingPermissionForTask(taskId), questionRequest: pendingQuestionForTask(taskId), eventType: "bootstrap" }); void getTaskDetail(taskId).then((d) => { if (!sse?.closed) sse?.send("snapshot", { type: "snapshot", task: d, messages: d.messages, isStreaming: d.isStreaming, permissionRequest: pendingPermissionForTask(taskId), questionRequest: pendingQuestionForTask(taskId), eventType: "ready" }); }).catch((e) => { sse?.send("error", { error: e instanceof Error ? e.message : String(e) }); sse?.close(); }); } catch (e) { sse.send("error", { error: e instanceof Error ? e.message : String(e) }); sse.close(); } req.signal.addEventListener("abort", () => sse?.close()); }, cancel() { sse?.cleanup(); } });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-cache, no-transform", Connection: "keep-alive" } });
}
