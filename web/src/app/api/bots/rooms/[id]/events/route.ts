import { NextRequest } from "next/server";
import { getRoom, roomBotTaskId, subscribeRoom } from "@/lib/rooms";
import { pendingPermissionForTask, pendingQuestionForTask, subscribeTask } from "@/lib/pi/harness";
import { createSseWriter } from "@/lib/sse-writer";
import type { RoomAttention, RoomDto } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cheap change key. Every room write bumps `updatedAt`, so a task event that changed nothing
 * costs a comparison instead of serialising the whole transcript.
 */
export function roomSnapshotSignature(room: RoomDto, attention: RoomAttention[]): string {
  const waiting = attention.map((item) => `${item.botId}:${item.permission?.id ?? ""}:${item.question?.id ?? ""}`).join(",");
  return `${room.updatedAt}|${room.messages.length}|${room.members.join(",")}|${waiting}`;
}
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!getRoom(id)) return new Response("Room not found", { status: 404 });
  let sse: ReturnType<typeof createSseWriter> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      sse = createSseWriter(controller);
      const subscriptions = new Map<string, () => void>();
      let previous = "";
      const snapshot = () => {
        if (sse?.closed) return;
        const room = getRoom(id);
        if (!room) { sse?.close(); return; }
        const tasks = new Set(room.members.map((botId) => roomBotTaskId(id, botId)));
        for (const [taskId, unsubscribe] of subscriptions) if (!tasks.has(taskId)) { unsubscribe(); subscriptions.delete(taskId); }
        for (const taskId of tasks) if (!subscriptions.has(taskId)) {
          subscriptions.set(taskId, subscribeTask(taskId, (payload) => { if (payload.type === "snapshot") snapshot(); }));
        }
        const attention: RoomAttention[] = room.members.map((botId) => {
          const taskId = roomBotTaskId(id, botId);
          return { botId, taskId, permission: pendingPermissionForTask(taskId), question: pendingQuestionForTask(taskId) };
        }).filter((item) => item.permission || item.question);
        const signature = roomSnapshotSignature(room, attention);
        if (signature !== previous) { previous = signature; sse?.send("snapshot", { type: "snapshot", room, attention }); }
      };
      const unsubscribe = subscribeRoom(id, snapshot);
      // Room files are shared across Next workers; local emitter events alone miss remote outbox reports.
      const refresh = setInterval(snapshot, 2_000);
      refresh.unref?.();
      sse.onCleanup(() => { unsubscribe(); clearInterval(refresh); for (const off of subscriptions.values()) off(); });
      sse.startHeartbeat();
      snapshot();
      req.signal.addEventListener("abort", () => sse?.close());
    },
    cancel() { sse?.cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-cache, no-transform", Connection: "keep-alive" } });
}
