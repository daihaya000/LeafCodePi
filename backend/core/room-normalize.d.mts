import type { RoomDto, RoomOutcome } from "@shared/types";

export const ROOM_OUTCOME_KINDS: readonly string[];

export function normalizeOutcome(value: unknown): RoomOutcome | undefined;

/** Returns the normalized room, or null when the record is not a room with this id. */
export function normalizeRoom(
  value: Partial<RoomDto>,
  id: string,
  handoffStates: readonly string[],
): RoomDto | null;
