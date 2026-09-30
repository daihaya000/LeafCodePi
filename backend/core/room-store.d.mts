import type { RoomDto } from "@shared/types";

export type RoomRelayEnvelope = {
  roomId: string;
  sourceBotId: string;
  targetBotIds: string[];
  turnId: string;
  depth: number;
  parentId?: string;
  consumed: boolean;
  expiresAt: number;
};
export type RoomRelayState = { envelopes: Record<string, RoomRelayEnvelope>; claims: Record<string, string[]> };

export const ROOM_ID_PATTERN: RegExp;
export const MAX_LIVE_ROOM_MESSAGES: number;
export const ROOM_IMAGE_EXTENSIONS: Record<string, string>;
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
  roomDataRoot(id: string): string;
  relayStatePath(roomId: string): string;
  readRelayState(roomId: string): RoomRelayState;
  writeRelayState(roomId: string, state: RoomRelayState): void;
  roomImagePath(roomId: string, file: string): string;
  roomFilePath(roomId: string, file: string): string;
  readRoomImage(roomId: string, file: string): { bytes: Buffer; mimeType: string } | undefined;
  readRoomFile(roomId: string, file: string): { bytes: Buffer } | undefined;
  readRoom(id: string): RoomDto | undefined;
  writeRoom(room: RoomDto): void;
  /** Archives everything beyond the live cap; returns the number archived. */
  archiveOverflow(room: RoomDto, maxLiveMessages?: number): number;
  listRooms(): RoomDto[];
}
