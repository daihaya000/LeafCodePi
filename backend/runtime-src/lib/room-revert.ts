import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { cancelRoomCodeRequests } from "@/lib/pi/bot-code-relay";
import { clearPendingAttentionForTask } from "@/lib/pi/harness";
import { getRoom, readRoomFile, readRoomImage, revertRoomTo, roomBotTaskId } from "@/lib/rooms";
import { stopRoomTurns } from "@/lib/room-runtime";
import type { RoomDto, RoomFile, RoomImage } from "@/lib/types";

/**
 * Rewind a Room conversation to just before one user request.
 *
 * Backend-only ladder: validate, stop turns, rewind shared history, clear discarded attention/Code.
 * The composer wrapper below also reads attachment bytes in Backend; Next is transport only.
 */
export async function revertRoomConversation(roomId: string, messageId: string): Promise<{
  room: RoomDto;
  text: string;
  images: RoomImage[];
  files: RoomFile[];
  cancelledCodeRequests: number;
}> {
  assertConfigurationOwner();
  const existing = getRoom(roomId);
  if (!existing) throw Object.assign(new Error("Room not found"), { status: 404 });
  // Validate before stop: an invalid target must not destroy in-flight turns.
  const target = existing.messages.find((message) => message.id === messageId);
  if (!target || target.role !== "user") {
    throw Object.assign(new Error("巻き戻せるユーザー発言が見つかりません"), { status: 404 });
  }
  // Stop first: a conversation still running would append new turns into the rewound transcript.
  try {
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
    room: getRoom(roomId) ?? (() => { throw new Error("Room disappeared after rewind"); })(),
    text: reverted.text,
    images: reverted.images,
    files: reverted.files,
    cancelledCodeRequests,
  };
  } catch { throw Object.assign(new Error("Room会話の処理結果を確認できません"), { status: 503 }); }
}

/** Rehydrate composer attachments only in the owner, after the shared transcript has been rewound. */
export async function revertRoomComposer(roomId: string, messageId: string) {
  assertConfigurationOwner();
  const reverted = await revertRoomConversation(roomId, messageId);
  try {
    const images = reverted.images.flatMap(image => {
      const stored = readRoomImage(roomId, image.file);
      return stored ? [{ uri: `data:${stored.mimeType};base64,${stored.bytes.toString("base64")}`, mime: stored.mimeType }] : [];
    });
    const files = reverted.files.flatMap(file => {
      const stored = readRoomFile(roomId, file.file);
      return stored ? [{ uri: `data:${file.mimeType};base64,${stored.bytes.toString("base64")}`, mime: file.mimeType, name: file.name }] : [];
    });
    return { room: reverted.room, text: reverted.text, images, files, cancelledCodeRequests: reverted.cancelledCodeRequests };
  } catch { throw Object.assign(new Error("Room会話の処理結果を確認できません"), { status: 503 }); }
}
