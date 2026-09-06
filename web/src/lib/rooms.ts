import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { dataDir } from "./paths";
import { getBot, listBots } from "./bots";
import type { BotDto, RoomDto, RoomMessage } from "./types";

type RoomFile = RoomDto;
const roomEvents = new EventEmitter();
roomEvents.setMaxListeners(0);

function roomsRoot(): string { return join(dataDir(), "bots", "rooms"); }
function assertId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) throw new Error("invalid room id");
}
function roomPath(id: string): string { assertId(id); return join(roomsRoot(), `${id}.json`); }
function normalizeRoom(value: Partial<RoomFile>, id: string): RoomDto | null {
  if (value.id !== id || typeof value.name !== "string" || !Array.isArray(value.members)) return null;
  const messages = Array.isArray(value.messages) ? value.messages.filter((item): item is RoomMessage => Boolean(item && typeof item === "object" && typeof item.id === "string" && (item.role === "user" || item.role === "assistant") && typeof item.text === "string" && typeof item.createdAt === "number")) : [];
  return {
    id,
    name: value.name,
    members: [...new Set(value.members.filter((item): item is string => typeof item === "string"))],
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
    messages,
  };
}
function readRoom(id: string): RoomDto | undefined {
  try { return normalizeRoom(JSON.parse(readFileSync(roomPath(id), "utf8")) as Partial<RoomFile>, id) ?? undefined; } catch { return undefined; }
}
function writeRoom(room: RoomDto): void {
  mkdirSync(roomsRoot(), { recursive: true });
  writeFileSync(roomPath(room.id), `${JSON.stringify(room, null, 2)}\n`, "utf8");
  roomEvents.emit(room.id, room);
}
function validMembers(members: string[]): string[] {
  return [...new Set(members)].filter((id) => Boolean(getBot(id)));
}

export function listRooms(): RoomDto[] {
  if (!existsSync(roomsRoot())) return [];
  return readdirSync(roomsRoot(), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readRoom(entry.name.slice(0, -5)))
    .filter((room): room is RoomDto => Boolean(room))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function getRoom(id: string): RoomDto | undefined { return readRoom(id); }
export function createRoom(input: { name?: string; members?: string[] }): RoomDto {
  const now = new Date().toISOString();
  const room: RoomDto = { id: randomUUID(), name: input.name?.trim() || "New room", members: validMembers(input.members ?? []), createdAt: now, updatedAt: now, messages: [] };
  writeRoom(room);
  return room;
}
export function patchRoom(id: string, patch: { name?: string; members?: string[] }): RoomDto | undefined {
  const room = readRoom(id);
  if (!room) return undefined;
  if (patch.name !== undefined) room.name = patch.name.trim() || room.name;
  if (patch.members !== undefined) room.members = validMembers(patch.members);
  room.updatedAt = new Date().toISOString();
  writeRoom(room);
  return room;
}
export function deleteRoom(id: string): boolean {
  if (!readRoom(id)) return false;
  rmSync(roomPath(id), { force: true });
  roomEvents.emit(id, null);
  return true;
}
export function appendRoomMessage(id: string, message: Omit<RoomMessage, "id" | "createdAt"> & { id?: string; createdAt?: number }): RoomMessage | undefined {
  const room = readRoom(id);
  if (!room) return undefined;
  const next: RoomMessage = { ...message, id: message.id ?? randomUUID(), createdAt: message.createdAt ?? Date.now() };
  room.messages.push(next);
  room.updatedAt = new Date().toISOString();
  writeRoom(room);
  return next;
}
export function updateRoomMessage(id: string, messageId: string, patch: Partial<Pick<RoomMessage, "text" | "status" | "botName">>): RoomMessage | undefined {
  const room = readRoom(id);
  const message = room?.messages.find((item) => item.id === messageId);
  if (!room || !message) return undefined;
  Object.assign(message, patch);
  room.updatedAt = new Date().toISOString();
  writeRoom(room);
  return message;
}
export function subscribeRoom(id: string, listener: (room: RoomDto | null) => void): () => void {
  roomEvents.on(id, listener);
  return () => roomEvents.off(id, listener);
}

/** User messages address only named members; an empty result intentionally means no bot work. */
export function botsForRoomPrompt(room: RoomDto, prompt: string, broadcast = false, bots: BotDto[] = listBots()): { bots: BotDto[]; broadcast: boolean } {
  const members = bots.filter((bot) => room.members.includes(bot.id) && bot.enabled);
  const isBroadcast = broadcast || /(^|\s)@everyone(?:\b|$)/i.test(prompt) || /(^|\s)@all(?:\b|$)/i.test(prompt);
  if (isBroadcast) return { bots: members, broadcast: true };
  const lowered = prompt.toLocaleLowerCase();
  return { bots: members.filter((bot) => lowered.includes(`@${bot.name.toLocaleLowerCase()}`) || lowered.includes(`@${bot.id.toLocaleLowerCase()}`)), broadcast: false };
}
