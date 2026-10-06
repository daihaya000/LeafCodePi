import { NextRequest } from "next/server";
import { getRoom, roomBotTaskId, subscribeRoom } from "@/lib/rooms";
import {
  linkedCodeTaskIdsForOrigin,
  pendingPermissionForTask,
  pendingQuestionForTask,
  subscribeTask,
} from "@/lib/pi/harness";
import { createSseWriter } from "@/lib/sse-writer";
import { sseResponse } from "@/lib/sse-response";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardPendingRequestsByTask, type PendingRequestsByTask } from "@/lib/backend-forward";
import { BACKEND_TASK_STREAM_REASON, subscribeBackendTaskDirty } from "@/lib/backend-task-dirty-hub";
import { roomSnapshotSignature } from "@/lib/room-events";
import type { RoomAttention, RoomDto, RoomMessage } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Return changed rows when the message order is stable; null requires a full-room fallback. */
function changedRoomMessages(previous: RoomDto | undefined, next: RoomDto): RoomMessage[] | null {
  if (!previous || previous.id !== next.id || previous.messages.length > next.messages.length) return null;
  const changed: RoomMessage[] = [];
  for (let index = 0; index < previous.messages.length; index += 1) {
    const before = previous.messages[index];
    const after = next.messages[index];
    if (before.id !== after.id) return null;
    if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(after);
  }
  changed.push(...next.messages.slice(previous.messages.length));
  return changed;
}

function roomMetadata(room: RoomDto): Omit<RoomDto, "messages"> {
  return Object.fromEntries(Object.entries(room).filter(([key]) => key !== "messages")) as Omit<RoomDto, "messages">;
}

/** True when the owner's pending map differs from the one we last reported. */
function pendingRequestsChanged(
  previous: PendingRequestsByTask | null,
  next: PendingRequestsByTask,
): boolean {
  if (!previous) return true;
  const previousKeys = Object.keys(previous).sort();
  const nextKeys = Object.keys(next).sort();
  if (previousKeys.length !== nextKeys.length) return true;
  return previousKeys.some((key, index) => {
    if (key !== nextKeys[index]) return true;
    const before = previous[key];
    const after = next[key];
    return JSON.stringify(before) !== JSON.stringify(after);
  });
}

/**
 * Safety-net poll when Backend owns the room.
 * Dirty wakes already call snapshot(); getRoom() is always a fresh disk read (no cache).
 * The longer interval is only for missed wakes / streaming text that may lack non-delta dirty.
 */
const ROOM_BACKEND_POLL_MS = 5_000;
/** Dirty events wake snapshots immediately; keep a 5s disk safety net for missed room-file updates. */
const ROOM_BACKEND_DIRTY_POLL_MS = 5_000;
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
      let previousRoomJson: string | undefined;
      // After the cutover the pending approvals/questions live in the Backend, so they are read from
      // there once per refresh instead of from this process's memory.
      const backendOwns = localRuntimeBlocked();
      let pendingBusy = false;
      /** Dirty / interval wakes that arrived while a snapshot was in flight. */
      let dirtyQueued = false;
      let dirtyAttached = false;
      let refresh: ReturnType<typeof setInterval> | undefined;
      /** The last map the owner reported. A failed read keeps it, so an unanswered prompt stays visible. */
      // Seeded with the empty map rather than null: the first successful read is not
      // a change, so an idle Room does not pay one extra room re-read on connect.
      let backendPending: PendingRequestsByTask | null = backendOwns ? {} : null;

      const attentionFor = (room: RoomDto): RoomAttention[] => room.members.map((botId) => {
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

      const emitIfChanged = (room: RoomDto, attention: RoomAttention[]) => {
        const signature = roomSnapshotSignature(room, attention);
        if (signature === previous) return;
        const roomJson = JSON.stringify(room);
        const attentionJson = JSON.stringify(attention);
        const roomReused = roomJson === previousRoomJson;
        const previousRoom = !roomReused && previousRoomJson ? JSON.parse(previousRoomJson) as RoomDto : undefined;
        const messagesDelta = roomReused ? null : changedRoomMessages(previousRoom, room);
        const metadata = messagesDelta ? roomMetadata(room) : null;
        const deltaFields = messagesDelta && metadata
          ? `"roomMetadata":${JSON.stringify(metadata)},"roomMessagesDelta":${JSON.stringify(messagesDelta)}`
          : null;
        const useDelta = deltaFields !== null && Buffer.byteLength(deltaFields) < Buffer.byteLength(`"room":${roomJson}`);
        if (sse?.sendSerialized) {
          const roomField = roomReused ? '"roomReused":true' : useDelta ? deltaFields! : `"room":${roomJson}`;
          sse.sendSerialized("snapshot", `{"type":"snapshot",${roomField},"attention":${attentionJson}}`);
        } else {
          sse?.send("snapshot", roomReused
            ? { type: "snapshot", roomReused: true, attention }
            : useDelta
              ? { type: "snapshot", roomMetadata: metadata!, roomMessagesDelta: messagesDelta!, attention }
              : { type: "snapshot", room, attention });
        }
        previous = signature;
        previousRoomJson = roomJson;
      };

      const collectTasks = (room: RoomDto): Set<string> => {
        const tasks = new Set(room.members.map((botId) => roomBotTaskId(id, botId)));
        for (const botId of room.members) {
          const origin = roomBotTaskId(id, botId);
          for (const linked of linkedCodeTaskIdsForOrigin(origin)) tasks.add(linked);
        }
        return tasks;
      };

      const syncLocalTaskSubs = (tasks: Set<string>) => {
        // After cutover this process has no live emitters for those tasks — dirty + disk poll wake instead.
        if (!backendOwns) {
          for (const [taskId, unsubscribe] of subscriptions) {
            if (!tasks.has(taskId)) {
              unsubscribe();
              subscriptions.delete(taskId);
            }
          }
          for (const taskId of tasks) {
            if (subscriptions.has(taskId)) continue;
            subscriptions.set(taskId, subscribeTask(taskId, (payload) => {
              if (payload.type === "snapshot") void snapshot();
            }));
          }
          return;
        }
        if (subscriptions.size > 0) {
          for (const off of subscriptions.values()) off();
          subscriptions.clear();
        }
      };

      const rescheduleRefresh = () => {
        if (refresh) clearInterval(refresh);
        const intervalMs = !backendOwns
          ? ROOM_LOCAL_POLL_MS
          : dirtyAttached
            ? ROOM_BACKEND_DIRTY_POLL_MS
            : ROOM_BACKEND_POLL_MS;
        refresh = setInterval(() => void snapshot(), intervalMs);
        refresh.unref?.();
      };

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
            // Room bodies come from the room file, which streaming text never touches: skip the
            // per-token wakes so a streaming member does not re-read the file and pending map 5x/s.
            dirtyStops.set(taskId, subscribeBackendTaskDirty(taskId, (payload) => {
              if (payload?.reason === BACKEND_TASK_STREAM_REASON) return;
              void snapshot();
            }));
            if (!dirtyAttached) {
              dirtyAttached = true;
              rescheduleRefresh();
            }
          } catch {
            // Hub connect failures fall back to the safety-net poll.
          }
        }
        if (dirtyStops.size === 0 && dirtyAttached) {
          dirtyAttached = false;
          rescheduleRefresh();
        }
      };

      const snapshot = async () => {
        if (sse?.closed) return;
        if (backendOwns && pendingBusy) {
          dirtyQueued = true;
          return;
        }
        if (backendOwns) pendingBusy = true;
        // The busy flag must clear even when a read or a send fails: a stuck flag would freeze the
        // stream until the client reconnects, and a rejection must not escape the interval callback.
        try {
          // Disk-first: getRoom() always re-reads the room file. Emit with the last-known pending
          // map so cutover room body / outbox cards do not wait on the pending HTTP round-trip.
          let room = getRoom(id);
          if (!room) { sse?.close(); return; }
          let tasks = collectTasks(room);
          syncLocalTaskSubs(tasks);
          syncDirty(tasks);
          if (backendOwns) emitIfChanged(room, attentionFor(room));

          if (backendOwns) {
            try {
              const forwarded = await forwardPendingRequestsByTask();
              // An unchanged pending map means the awaited round-trip told us nothing
              // new, so the room file cannot have changed either: skipping the re-read
              // keeps an idle Room off the disk and off the wire every 2 seconds.
              const changed = forwarded.ok && pendingRequestsChanged(backendPending, forwarded.byTask);
              if (forwarded.ok) backendPending = forwarded.byTask;
              if (changed) {
                if (sse?.closed) return;
                // Re-read after the await: another Backend write may have landed while pending was in flight.
                room = getRoom(id);
                if (!room) { sse?.close(); return; }
                tasks = collectTasks(room);
                syncLocalTaskSubs(tasks);
                syncDirty(tasks);
              }
            } catch {
              // Keep the previous map; the next poll retries.
            }
          }

          if (room) emitIfChanged(room, attentionFor(room));
        } finally {
          pendingBusy = false;
          if (dirtyQueued) {
            dirtyQueued = false;
            void snapshot();
          }
        }
      };
      const unsubscribe = subscribeRoom(id, () => void snapshot());
      // Room files are shared across Next workers; local emitter events alone miss remote outbox reports.
      rescheduleRefresh();
      sse.onCleanup(() => {
        unsubscribe();
        if (refresh) clearInterval(refresh);
        for (const off of subscriptions.values()) off();
        for (const stop of dirtyStops.values()) stop();
        dirtyStops.clear();
      });
      sse.startHeartbeat();
      void snapshot();
    },
    cancel() { sse?.cleanup(); },
  });
  return sseResponse(req.headers.get("accept-encoding"), stream);
}
