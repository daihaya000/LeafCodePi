import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createRoom, getRoom, listRooms } from "./rooms";
export function listRoomConfiguration() { assertConfigurationOwner(); return { rooms: listRooms() }; }
export function readRoomConfiguration(id: string) {
  assertConfigurationOwner();
  const room = getRoom(id);
  return room ? { status: 200, body: { room } } : { status: 404, body: { error: "ルームが見つかりません" } };
}
export function createRoomConfiguration(input: Parameters<typeof createRoom>[0]) { assertConfigurationOwner(); return createRoom(input); }
