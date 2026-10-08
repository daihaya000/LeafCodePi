import { cancelRoomCodeRequests } from "@/lib/pi/bot-code-relay";
import { clearPendingAttentionForTask } from "@/lib/pi/harness";
import { getRoom, revertRoomTo, roomBotTaskId } from "@/lib/rooms";
import { stopRoomTurns } from "@/lib/room-runtime";
import type { RoomDto, RoomFile, RoomImage } from "@/lib/types";

/**
 * Rewind a Room conversation to just before one user request.
 *
 * The whole ladder — validate, stop the running turns, rewind the transcript, drop the discarded
 * attention and Code jobs — lives here because both the owning WebUI route and the Backend owner
 * perform it: only the owner may abort sessions, clear its in-memory attention or write the outbox,
 * so after the cutover the WebUI forwards the request instead. The stored image/file descriptors are
 * returned as-is: each process reads those shared files itself.
 */
export async function revertRoomConversation(roomId: string, messageId: string): Promise<{
  room: RoomDto;
  text: string;
  images: RoomImage[];
  files: RoomFile[];
  cancelledCodeRequests: number;
}> {
  const existing = getRoom(roomId);
  if (!existing) throw Object.assign(new Error("Room not found"), { status: 404 });
  // Validate before stop: an invalid target must not destroy in-flight turns.
  const target = existing.messages.find((message) => message.id === messageId);
  if (!target || target.role !== "user") {
    throw Object.assign(new Error("巻き戻せるユーザー発言が見つかりません"), { status: 404 });
  }
  // Stop first: a conversation still running would append new turns into the rewound transcript.
  await stopRoomTurns(roomId);
  const reverted = revertRoomTo(roomId, messageId);
  if (!reverted) throw Object.assign(new Error("巻き戻せるユーザー発言が見つかりません"), { status: 404 });
  // Drop member attention raised for the discarded transcript context.
  for (const memberId of existing.members) clearPendingAttentionForTask(roomBotTaskId(roomId, memberId));
  // Work started for removed requests has nowhere to report back to.
  let cancelledCodeRequests = 0;
  for (const requestId of reverted.requestIds) {
    cancelledCodeRequests += await cancelRoomCodeRequests(roomId, requestId);
  }
  return {
    room: getRoom(roomId) ?? existing,
    text: reverted.text,
    images: reverted.images,
    files: reverted.files,
    cancelledCodeRequests,
  };
}
