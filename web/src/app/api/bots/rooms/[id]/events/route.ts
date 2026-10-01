import { NextRequest } from "next/server";
import { getRoom, roomBotTaskId, subscribeRoom } from "@/lib/rooms";
import {
  linkedCodeTaskIdsForOrigin,
  pendingPermissionForTask,
  pendingQuestionForTask,
  subscribeTask,
} from "@/lib/pi/harness";
import { createSseWriter } from "@/lib/sse-writer";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardPendingRequestsByTask, type PendingRequestsByTask } from "@/lib/backend-forward";
import { subscribeBackendTaskDirty } from "@/lib/backend-task-dirty-hub";
import { roomSnapshotSignature } from "@/lib/room-events";
import type { RoomAttention } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Safety-net poll when Backend owns pending; dirty wakes refresh sooner. */
const ROOM_BACKEND_POLL_MS = 5_000;
const ROOM_LOCAL_POLL_MS = 2_000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!getRoom(id)) return new Response("Room not found", { status: 404 });
  let sse: ReturnType<typeof createSseWriter> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      sse = createSseWriter(controller, { signal: req.signal });
      const subscriptions = new Map<string, () => void>();
      const dirtyStops = new Map<string, () => void>();
      let previous = "";
      // After the cutover the pending approvals/questions live in the Backend, so they are read from
      // there once per refresh instead of from this process's memory.
      const backendOwns = localRuntimeBlocked();
      let pendingBusy = false;
      /** The last map the owner reported. A failed read keeps it, so an unanswered prompt stays visible. */
      let backendPending: PendingRequestsByTask | null = null;
      const syncDirty = (taskIds: Set<string>) => {
        if (!backendOwns) return;
        for (const [taskId, stop] of dirtyStops) {
          if (taskIds.has(taskId)) continue;
          stop();
          dirtyStops.delete(taskId);
        }
        for (const taskId of taskIds) {
          if (dirtyStops.has(taskId)) continue;
          try {
            dirtyStops.set(taskId, subscribeBackendTaskDirty(taskId, () => { void snapshot(); }));
          } catch {
            // Hub connect failures fall back to the safety-net poll.
          }
        }
      };
      const snapshot = async () => {
        if (sse?.closed) return;
        if (backendOwns && pendingBusy) return;
        if (backendOwns) pendingBusy = true;
        // The busy flag must clear even when a read or a send fails: a stuck flag would freeze the
        // stream until the client reconnects, and a rejection must not escape the interval callback.
        try {
          if (backendOwns) {
            try {
              const forwarded = await forwardPendingRequestsByTask();
              if (forwarded.ok) backendPending = forwarded.byTask;
            } catch {
              // Keep the previous map; the next poll retries.
            }
          }
          if (sse?.closed) return;
          const room = getRoom(id);
          if (!room) { sse?.close(); return; }
          const tasks = new Set(room.members.map((botId) => roomBotTaskId(id, botId)));
          for (const botId of room.members) {
            const origin = roomBotTaskId(id, botId);
            for (const linked of linkedCodeTaskIdsForOrigin(origin)) tasks.add(linked);
          }
          // After cutover this process has no live emitters for those tasks — dirty + disk poll wake instead.
          if (!backendOwns) {
            for (const [taskId, unsubscribe] of subscriptions) if (!tasks.has(taskId)) { unsubscribe(); subscriptions.delete(taskId); }
            for (const taskId of tasks) if (!subscriptions.has(taskId)) {
              subscriptions.set(taskId, subscribeTask(taskId, (payload) => { if (payload.type === "snapshot") snapshot(); }));
            }
          } else if (subscriptions.size > 0) {
            for (const off of subscriptions.values()) off();
            subscriptions.clear();
          }
          syncDirty(tasks);
          const attention: RoomAttention[] = room.members.map((botId) => {
            const taskId = roomBotTaskId(id, botId);
            // After the cutover this process must not read its own prompt services: the owner's map is
            // the only source, and its absence means nothing is pending rather than "ask locally".
            const pending = backendPending?.[taskId];
            return {
              botId,
              taskId,
              permission: backendOwns ? pending?.permissionRequest ?? null : pendingPermissionForTask(taskId),
              question: backendOwns ? pending?.questionRequest ?? null : pendingQuestionForTask(taskId),
            };
          }).filter((item) => item.permission || item.question);
          const signature = roomSnapshotSignature(room, attention);
          if (signature !== previous) { previous = signature; sse?.send("snapshot", { type: "snapshot", room, attention }); }
        } finally {
          pendingBusy = false;
        }
      };
      const unsubscribe = subscribeRoom(id, () => void snapshot());
      // Room files are shared across Next workers; local emitter events alone miss remote outbox reports.
      const refresh = setInterval(() => void snapshot(), backendOwns ? ROOM_BACKEND_POLL_MS : ROOM_LOCAL_POLL_MS);
      refresh.unref?.();
      sse.onCleanup(() => {
        unsubscribe();
        clearInterval(refresh);
        for (const off of subscriptions.values()) off();
        for (const stop of dirtyStops.values()) stop();
        dirtyStops.clear();
      });
      sse.startHeartbeat();
      void snapshot();
    },
    cancel() { sse?.cleanup(); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
