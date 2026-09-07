import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { dataDir } from "./paths";
import { botTaskId, botWorkspace, getBot, listBots } from "./bots";
import { deleteTask, getTask, insertBotTask, listTasks, patchTask } from "./store";
import type { BotDto, RoomDto, RoomMessage } from "./types";

type RoomFile = RoomDto;
const roomEvents = new EventEmitter();
export const MAX_ROOM_RELAY_DEPTH = 3;
type RoomRelayEnvelope = { roomId: string; sourceBotId: string; targetBotIds: string[]; turnId: string; depth: number; parentId?: string; consumed: boolean; expiresAt: number };
type RoomRelayState = { envelopes: Record<string, RoomRelayEnvelope>; claims: Record<string, string[]> };
const RELAY_ENVELOPE_TTL_MS = 10 * 60 * 1000;

function relayRoot(roomId: string): string { return join(roomsRoot(), roomId); }
function relayStatePath(roomId: string): string { assertId(roomId); return join(relayRoot(roomId), "relay.json"); }
function readRelayState(roomId: string): RoomRelayState {
  try {
    const value = JSON.parse(readFileSync(relayStatePath(roomId), "utf8")) as Partial<RoomRelayState>;
    const envelopes = value.envelopes && typeof value.envelopes === "object" ? value.envelopes : {};
    const claims = value.claims && typeof value.claims === "object" ? value.claims : {};
    return { envelopes: envelopes as Record<string, RoomRelayEnvelope>, claims: claims as Record<string, string[]> };
  } catch { return { envelopes: {}, claims: {} }; }
}
function writeRelayState(roomId: string, state: RoomRelayState): void {
  mkdirSync(relayRoot(roomId), { recursive: true });
  const path = relayStatePath(roomId);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  // Rename is atomic on the room's local filesystem, so a restart never sees
  // a half-written claim/envelope file.
  renameSync(temporary, path);
}

/** Serialize read/check/write across workers; stale locks are recoverable after a crash. */
function withRelayLock<T>(roomId: string, action: () => T): T {
  const root = relayRoot(roomId);
  const lock = join(root, "relay.lock");
  mkdirSync(root, { recursive: true });
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
      } catch { /* another worker removed it */ }
      if (attempt >= 300) throw new Error("relay state is busy");
      Atomics.wait(waitBuffer, 0, 0, 10);
    }
  }
  try { return action(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

function relayBotIsActive(room: RoomDto, botId: string): boolean {
  return room.members.includes(botId) && getBot(botId)?.enabled === true;
}

function relayParticipants(roomId: string, turnId: string): Set<string> {
  const room = getRoom(roomId);
  const state = readRelayState(roomId);
  const ids = new Set(state.claims[turnId] ?? []);
  for (const message of room?.messages ?? []) {
    if (message.relayTurnId !== turnId) continue;
    if (message.sourceBotId) ids.add(message.sourceBotId);
    if (message.botId) ids.add(message.botId);
  }
  return ids;
}

/** Server-only capability. The route accepts only the returned opaque envelope, never its fields. */
export function issueRoomRelayEnvelope(roomId: string, sourceBotId: string, targetBotIds: string[], parentId?: string): string | undefined {
  return withRelayLock(roomId, () => {
    const room = getRoom(roomId);
    if (!room?.botRelayEnabled || !relayBotIsActive(room, sourceBotId)) return undefined;
    const targets = [...new Set(targetBotIds)];
    if (targets.length === 0 || targets.some((id) => id === sourceBotId || !relayBotIsActive(room, id))) return undefined;
    const state = readRelayState(roomId);
    const parent = parentId ? state.envelopes[parentId] : undefined;
    if (parentId && (!parent || !parent.consumed || parent.roomId !== roomId || parent.expiresAt <= Date.now() || !parent.targetBotIds.includes(sourceBotId))) return undefined;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_ROOM_RELAY_DEPTH) return undefined;
    const turnId = parent?.turnId ?? randomUUID();
    const participants = relayParticipants(roomId, turnId);
    if (targets.some((id) => participants.has(id))) return undefined;
    const token = randomUUID();
    state.envelopes[token] = { roomId, sourceBotId, targetBotIds: targets, turnId, depth, parentId, consumed: false, expiresAt: Date.now() + RELAY_ENVELOPE_TTL_MS };
    writeRelayState(roomId, state);
    return token;
  });
}

export function consumeRoomRelayEnvelope(roomId: string, token: string): Omit<RoomRelayEnvelope, "parentId" | "consumed" | "expiresAt"> | undefined {
  return withRelayLock(roomId, () => {
    const state = readRelayState(roomId);
    const envelope = state.envelopes[token];
    const room = getRoom(roomId);
    if (!room?.botRelayEnabled || !envelope || envelope.roomId !== roomId || envelope.consumed || envelope.expiresAt <= Date.now()) return undefined;
    if (!relayBotIsActive(room, envelope.sourceBotId) || !Array.isArray(envelope.targetBotIds) || envelope.targetBotIds.length === 0 || envelope.targetBotIds.some((id) => id === envelope.sourceBotId || !relayBotIsActive(room, id))) return undefined;
    const participants = relayParticipants(roomId, envelope.turnId);
    if (envelope.targetBotIds.some((id) => participants.has(id))) return undefined;
    envelope.consumed = true;
    const claims = new Set(state.claims[envelope.turnId] ?? []);
    claims.add(envelope.sourceBotId);
    for (const id of envelope.targetBotIds) claims.add(id);
    state.claims[envelope.turnId] = [...claims];
    writeRelayState(roomId, state);
    return { roomId: envelope.roomId, sourceBotId: envelope.sourceBotId, targetBotIds: envelope.targetBotIds, turnId: envelope.turnId, depth: envelope.depth };
  });
}

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
    botRelayEnabled: value.botRelayEnabled === true,
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
  const room: RoomDto = { id: randomUUID(), name: input.name?.trim() || "New room", members: validMembers(input.members ?? []), botRelayEnabled: false, createdAt: now, updatedAt: now, messages: [] };
  writeRoom(room);
  return room;
}
export function patchRoom(id: string, patch: { name?: string; members?: string[]; botRelayEnabled?: boolean }): RoomDto | undefined {
  const room = readRoom(id);
  if (!room) return undefined;
  if (patch.name !== undefined) room.name = patch.name.trim() || room.name;
  if (patch.members !== undefined) room.members = validMembers(patch.members);
  if (patch.botRelayEnabled !== undefined) room.botRelayEnabled = patch.botRelayEnabled;
  room.updatedAt = new Date().toISOString();
  writeRoom(room);
  return room;
}
export function deleteRoom(id: string): boolean {
  if (!readRoom(id)) return false;
  rmSync(roomPath(id), { force: true });
  rmSync(relayRoot(id), { recursive: true, force: true });
  for (const task of listTasks(true, "bot")) {
    if (task.id.endsWith(`:room:${id}`)) deleteTask(task.id);
  }
  roomEvents.emit(id, null);
  return true;
}

/** Room replies run in their own session so they never land in the bot's 1:1 chat. */
export function roomBotTaskId(roomId: string, botId: string): string { return `bot:${botId}:room:${roomId}`; }

/** Creates the room session on demand and keeps its model routing in sync with the bot's 1:1 task. */
export function ensureRoomBotTask(room: RoomDto, bot: BotDto): string {
  const id = roomBotTaskId(room.id, bot.id);
  const title = `${bot.name} @ ${room.name}`;
  insertBotTask({ id, botId: bot.id, name: title, directory: botWorkspace(bot.id), thinkingLevel: bot.thinkingLevel, permissionMode: bot.permissionMode });
  const base = getTask(botTaskId(bot.id));
  // ponytail: routing is copied on each prompt; a model change during a live room turn applies from the next turn.
  if (base) patchTask(id, { title, providerID: base.providerID, modelID: base.modelID, thinkingLevel: base.thinkingLevel, accountId: base.accountId, accountIdExplicit: base.accountIdExplicit, permissionMode: base.permissionMode });
  return id;
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
  const isBroadcast = broadcast || /(^|\s)@(everyone|all|here|channel)(?:\b|$)/i.test(prompt);
  if (isBroadcast) return { bots: members, broadcast: true };
  const lowered = prompt.toLocaleLowerCase();
  return { bots: members.filter((bot) => lowered.includes(`@${bot.name.toLocaleLowerCase()}`) || lowered.includes(`@${bot.id.toLocaleLowerCase()}`)), broadcast: false };
}
