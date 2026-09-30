import type { RoomDto, RoomMessage } from "@shared/types";
import type { RoomRelayEnvelope, RoomRelayState } from "./room-store.mjs";

export const MAX_ROOM_RELAY_DEPTH: number;
export const RELAY_ENVELOPE_TTL_MS: number;
export type { RoomRelayEnvelope, RoomRelayState };

export type ConsumedRelayEnvelope = {
  roomId: string;
  sourceBotId: string;
  targetBotIds: string[];
  turnId: string;
  depth: number;
};

export function relayBotIsActive(
  room: Pick<RoomDto, "members"> | undefined,
  botId: string,
  isBotEnabled: (botId: string) => boolean,
): boolean;

export function collectRelayParticipants(
  room: Pick<RoomDto, "messages"> | undefined,
  state: RoomRelayState,
  turnId: string,
): Set<string>;

export function parentRelayEnvelopeRejection(
  parentId: string | undefined,
  parent: RoomRelayEnvelope | undefined,
  roomId: string,
  sourceBotId: string,
  nowMs: number,
): boolean;

export function relayEnvelopeRejection(
  envelope: RoomRelayEnvelope | undefined,
  context: {
    room: RoomDto | undefined;
    roomId: string;
    nowMs: number;
    isBotEnabled: (botId: string) => boolean;
    isTargetInvolved: (botId: string) => boolean;
  },
): boolean;

export type RelayDeps = {
  withRoomLock: <T>(roomId: string, action: () => T) => T;
  getRoom: (roomId: string) => RoomDto | undefined;
  isBotEnabled: (botId: string) => boolean;
  readState: (roomId: string) => RoomRelayState;
  writeState: (roomId: string, state: RoomRelayState) => void;
  now: () => number;
  uuid: () => string;
};

export function issueRelayEnvelope(
  input: { roomId: string; sourceBotId: string; targetBotIds: string[]; parentId?: string },
  deps: RelayDeps,
): string | undefined;

export function consumeRelayEnvelope(
  input: { roomId: string; token: string },
  deps: RelayDeps,
): ConsumedRelayEnvelope | undefined;

/** Room messages carry the relay turn they belong to. */
export type RelayTurnMessage = Pick<RoomMessage, "relayTurnId" | "sourceBotId" | "botId">;
