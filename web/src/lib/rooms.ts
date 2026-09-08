import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { dataDir } from "./paths";
import { botTaskId, botWorkspace, getBot, listBots } from "./bots";
import { deleteTask, getTask, insertBotTask, listTasks, patchTask } from "./store";
import type { BotDto, RoomDto, RoomImage, RoomMessage, RoomOutcome } from "./types";
import type { PromptImageInput } from "./prompt-images";

type RoomFile = RoomDto;
const roomEvents = new EventEmitter();

/** Per-room data directory: archived history and attachments live here. */
function roomDataRoot(roomId: string): string { return join(roomsRoot(), roomId); }
function roomLockPath(roomId: string): string { assertId(roomId); return join(roomsRoot(), `${roomId}.lock`); }

/** Serialize room read/check/write operations across workers. */
function withRoomLock<T>(roomId: string, action: () => T): T {
  // Keep the public missing-room behavior for malformed route parameters.
  if (!isValidId(roomId)) return action();
  const lock = roomLockPath(roomId);
  mkdirSync(roomsRoot(), { recursive: true });
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
      } catch { /* another worker removed it */ }
      if (attempt >= 300) throw new Error("room file is busy");
      Atomics.wait(waitBuffer, 0, 0, 10);
    }
  }
  try { return action(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

roomEvents.setMaxListeners(0);

function roomsRoot(): string { return join(dataDir(), "bots", "rooms"); }
function isValidId(id: string): boolean { return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id); }
function assertId(id: string): void {
  if (!isValidId(id)) throw new Error("invalid room id");
}
function roomPath(id: string): string { assertId(id); return join(roomsRoot(), `${id}.json`); }
function normalizeOutcome(value: unknown): RoomOutcome | undefined {
  const outcome = value as Partial<RoomOutcome> | undefined;
  const kinds = ["code-wait", "members", "turns", "repeat", "done"];
  return outcome && typeof outcome.requestId === "string" && typeof outcome.kind === "string" && kinds.includes(outcome.kind)
    ? { kind: outcome.kind as RoomOutcome["kind"], requestId: outcome.requestId }
    : undefined;
}
function normalizeRoom(value: Partial<RoomFile>, id: string): RoomDto | null {
  if (value.id !== id || typeof value.name !== "string" || !Array.isArray(value.members)) return null;
  const messages = Array.isArray(value.messages) ? value.messages.filter((item): item is RoomMessage => Boolean(item && typeof item === "object" && typeof item.id === "string" && (item.role === "user" || item.role === "assistant") && typeof item.text === "string" && typeof item.createdAt === "number")) : [];
  const lastOutcome = normalizeOutcome(value.lastOutcome);
  return {
    id,
    name: value.name,
    members: [...new Set(value.members.filter((item): item is string => typeof item === "string"))],
    ...(value.codeAutoApprove === true ? { codeAutoApprove: true } : {}),
    ...(lastOutcome ? { lastOutcome } : {}),
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
  const path = roomPath(room.id);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(room, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
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
export function patchRoom(id: string, patch: { name?: string; members?: string[]; codeAutoApprove?: boolean }): RoomDto | undefined {
  return withRoomLock(id, () => {
    const room = readRoom(id);
    if (!room) return undefined;
    if (patch.name !== undefined) room.name = patch.name.trim() || room.name;
    if (patch.members !== undefined) room.members = validMembers(patch.members);
    if (patch.codeAutoApprove !== undefined) room.codeAutoApprove = patch.codeAutoApprove;
    room.updatedAt = new Date().toISOString();
    writeRoom(room);
    return room;
  });
}
export function deleteRoom(id: string): boolean {
  return withRoomLock(id, () => {
    if (!readRoom(id)) return false;
    rmSync(roomPath(id), { force: true });
    rmSync(roomDataRoot(id), { recursive: true, force: true });
    for (const task of listTasks(true, "bot")) {
      if (task.id.endsWith(`:room:${id}`)) deleteTask(task.id);
    }
    roomEvents.emit(id, null);
    return true;
  });
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
/** Live rooms stay a bounded file; older turns move to append-only history. */
const MAX_LIVE_ROOM_MESSAGES = 500;
function archiveOverflow(room: RoomDto): void {
  if (room.messages.length <= MAX_LIVE_ROOM_MESSAGES) return;
  const overflow = room.messages.splice(0, room.messages.length - MAX_LIVE_ROOM_MESSAGES);
  mkdirSync(roomDataRoot(room.id), { recursive: true });
  appendFileSync(join(roomDataRoot(room.id), "history.jsonl"), `${overflow.map((message) => JSON.stringify(message)).join("\n")}\n`, "utf8");
}
export function appendRoomMessage(id: string, message: Omit<RoomMessage, "id" | "createdAt"> & { id?: string; createdAt?: number }): RoomMessage | undefined {
  return withRoomLock(id, () => {
    const room = readRoom(id);
    if (!room) return undefined;
    const existing = message.id ? room.messages.find((item) => item.id === message.id) : undefined;
    if (existing) return existing;
    const next: RoomMessage = { ...message, id: message.id ?? randomUUID(), createdAt: message.createdAt ?? Date.now() };
    room.messages.push(next);
    archiveOverflow(room);
    room.updatedAt = new Date().toISOString();
    writeRoom(room);
    return next;
  });
}
export function updateRoomMessage(id: string, messageId: string, patch: Partial<Pick<RoomMessage, "text" | "status" | "botName" | "conversation" | "codeRequestId" | "codeTaskId" | "codeState" | "codeActivity" | "images">>): RoomMessage | undefined {
  return withRoomLock(id, () => {
    const room = readRoom(id);
    const message = room?.messages.find((item) => item.id === messageId);
    if (!room || !message) return undefined;
    Object.assign(message, patch);
    room.updatedAt = new Date().toISOString();
    writeRoom(room);
    return message;
  });
}
export function setRoomOutcome(id: string, outcome: RoomOutcome): void {
  withRoomLock(id, () => {
    const room = readRoom(id);
    if (!room) return;
    room.lastOutcome = outcome;
    room.updatedAt = new Date().toISOString();
    writeRoom(room);
  });
}
/**
 * Attachments live beside the room file, never inside it: the transcript is rewritten on every
 * turn, so inlined base64 would be re-serialised hundreds of times and shipped on every snapshot.
 */
const ROOM_IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_ROOM_IMAGES = 8;
const MAX_ROOM_IMAGE_BYTES = 8 * 1024 * 1024;
function roomImagePath(roomId: string, file: string): string {
  assertId(roomId);
  // Names are server-generated; anything else must not reach the filesystem.
  if (!/^[0-9a-f-]{36}-\d{1,2}\.(png|jpg|webp|gif)$/i.test(file)) throw new Error("invalid room image");
  return join(roomDataRoot(roomId), "images", file);
}
/** Reject at the boundary: a dropped attachment must not look like a delivered one. */
export function roomImageRejection(images: PromptImageInput[]): string | undefined {
  if (images.length > MAX_ROOM_IMAGES) return `画像は${MAX_ROOM_IMAGES}件までです`;
  for (const image of images) {
    if (!ROOM_IMAGE_EXTENSIONS[image.mimeType.toLowerCase()]) return `対応していない画像形式です: ${image.mimeType}`;
    const bytes = Buffer.byteLength(image.data, "base64");
    if (bytes === 0) return "画像データが空です";
    if (bytes > MAX_ROOM_IMAGE_BYTES) return `画像は1件${MAX_ROOM_IMAGE_BYTES / 1024 / 1024}MBまでです`;
  }
  return undefined;
}
export function saveRoomImages(roomId: string, messageId: string, images: PromptImageInput[]): RoomImage[] {
  assertId(roomId);
  assertId(messageId);
  mkdirSync(join(roomDataRoot(roomId), "images"), { recursive: true });
  return images.slice(0, MAX_ROOM_IMAGES).flatMap((image, index) => {
    const extension = ROOM_IMAGE_EXTENSIONS[image.mimeType.toLowerCase()];
    if (!extension) return [];
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_ROOM_IMAGE_BYTES) return [];
    const file = `${messageId}-${index}.${extension}`;
    writeFileSync(roomImagePath(roomId, file), bytes);
    return [{ file, mimeType: image.mimeType }];
  });
}
export function readRoomImage(roomId: string, file: string): { bytes: Buffer; mimeType: string } | undefined {
  try {
    const mimeType = Object.entries(ROOM_IMAGE_EXTENSIONS).find(([, extension]) => file.toLowerCase().endsWith(`.${extension}`))?.[0];
    return mimeType ? { bytes: readFileSync(roomImagePath(roomId, file)), mimeType } : undefined;
  } catch { return undefined; }
}
/** Attachments of a request, read back for the model. Turns after the first already have them in session. */
export function roomRequestImages(roomId: string, messageId: string): PromptImageInput[] {
  const message = getRoom(roomId)?.messages.find((item) => item.id === messageId);
  return (message?.images ?? []).flatMap((image) => {
    const stored = readRoomImage(roomId, image.file);
    return stored ? [{ mimeType: stored.mimeType, data: stored.bytes.toString("base64") }] : [];
  });
}

/**
 * Drop a user request and everything said after it, returning its text for the composer.
 * Bot sessions keep their own history: only the shared room transcript is rewound.
 */
export function revertRoomTo(id: string, messageId: string): { text: string; requestId: string } | undefined {
  return withRoomLock(id, () => {
    const room = readRoom(id);
    const index = room?.messages.findIndex((item) => item.id === messageId) ?? -1;
    const target = index >= 0 ? room!.messages[index] : undefined;
    if (!room || !target || target.role !== "user") return undefined;
    room.messages = room.messages.slice(0, index);
    if (room.lastOutcome?.requestId === messageId) delete room.lastOutcome;
    room.updatedAt = new Date().toISOString();
    writeRoom(room);
    return { text: target.text, requestId: messageId };
  });
}
export function subscribeRoom(id: string, listener: (room: RoomDto | null) => void): () => void {
  roomEvents.on(id, listener);
  return () => roomEvents.off(id, listener);
}

/** User messages address only named members; an empty result intentionally means no bot work. */
export function botsForRoomPrompt(room: RoomDto, prompt: string, broadcast = false, bots: BotDto[] = listBots()): { bots: BotDto[]; broadcast: boolean } {
  const members = bots.filter((bot) => room.members.includes(bot.id) && bot.enabled);
  const special = ["everyone", "all", "here", "channel"];
  const names = [...new Set([...special, ...members.flatMap((bot) => [bot.name, bot.id])])]
    .filter(Boolean).sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])@(${names.join("|")})(?![\\p{L}\\p{N}\\p{M}_-])`, "giu");
  const mentioned = new Set([...prompt.matchAll(pattern)].map((match) => match[1].toLowerCase()));
  if (broadcast || special.some((name) => mentioned.has(name))) return { bots: members, broadcast: true };
  return { bots: members.filter((bot) => mentioned.has(bot.name.toLowerCase()) || mentioned.has(bot.id.toLowerCase())), broadcast: false };
}
