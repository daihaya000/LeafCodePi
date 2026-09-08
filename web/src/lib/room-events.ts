import type { RoomAttention, RoomDto } from "./types";

/**
 * Cheap change key for the room stream. Every room write bumps `updatedAt`, so a task event that
 * changed nothing costs a comparison instead of serialising the whole transcript. The last
 * message and the outcome are included because two writes can share one millisecond.
 */
export function roomSnapshotSignature(room: RoomDto, attention: RoomAttention[]): string {
  const last = room.messages.at(-1);
  const waiting = attention.map((item) => `${item.botId}:${item.permission?.id ?? ""}:${item.question?.id ?? ""}`).join(",");
  return [
    room.updatedAt,
    room.messages.length,
    last?.id ?? "",
    last?.status ?? "",
    last?.text.length ?? 0,
    last?.codeState ?? "",
    last?.codeActivity ?? "",
    room.lastOutcome?.kind ?? "",
    room.members.join(","),
    waiting,
  ].join("|");
}
