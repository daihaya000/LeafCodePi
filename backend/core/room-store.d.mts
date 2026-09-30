import type { RoomDto } from "@shared/types";

export const ROOM_ID_PATTERN: RegExp;
export function isValidRoomId(id: string): boolean;

export class RoomFileStore {
  constructor(options: {
    roomsRoot: () => string;
    handoffStates: readonly string[];
    /** Called after a room file was durably replaced. */
    onWritten?: (room: RoomDto) => void;
  });
  assertId(id: string): void;
  roomPath(id: string): string;
  readRoom(id: string): RoomDto | undefined;
  writeRoom(room: RoomDto): void;
  listRooms(): RoomDto[];
}
