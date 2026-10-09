import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { dataDir } from "./paths";
import { withDirectoryLock } from "@backend-core/directory-lock.mjs";
import { RoomFileStore } from "@backend-core/room-store.mjs";
import { consumeRelayEnvelope, issueRelayEnvelope } from "@backend-core/room-relay.mjs";
import { botTaskId, botWorkspace, getBot, listBots } from "./bots";
import { deleteTask, getTask, insertBotTask, listTasks, patchTask } from "./store";
import { ROOM_HANDOFF_STATES } from "./types";
import type { BotDto, RoomDto, RoomFile, RoomHandoff, RoomImage, RoomMessage, RoomOutcome } from "./types";
import { isPromptFileText, isPromptFilesWithinTotalSize, isPromptFileWithinSize, isPromptImagesWithinTotalSize, isPromptImageWithinSize, MAX_PROMPT_FILE_TOTAL_BYTES, MAX_PROMPT_IMAGE_TOTAL_BYTES, type PromptFileInput, type PromptImageInput } from "./prompt-images";
const roomEvents = new EventEmitter();

/** Per-room data directory: archived history and attachments live here. */
function roomDataRoot(roomId: string): string { return join(roomsRoot(), roomId); }
function roomLockPath(roomId: string): string { assertId(roomId); return join(roomsRoot(), `${roomId}.lock`); }

export { MAX_ROOM_RELAY_DEPTH } from "@backend-core/room-relay.mjs";
/** Repeated in every Bot's turn prompt (see room-conversation.ts roomBotPrompt); keep it short. */
export const MAX_ROOM_NAME_CHARS = 100;

/** Code points, not UTF-16 units — same basis as isBotNameWithinSize(). */
export function isRoomNameWithinSize(value: string): boolean {
  return Array.from(value).length <= MAX_ROOM_NAME_CHARS;
}
type RoomRelayEnvelope = import("@backend-core/room-store.mjs").RoomRelayEnvelope;
type RoomRelayState = import("@backend-core/room-store.mjs").RoomRelayState;


/** Relay decisions live in backend core; the room, bots and clock are injected. */
const relayDeps = {
  withRoomLock: <T>(roomId: string, action: () => T): T => withRoomLock(roomId, action),
  getRoom: (roomId: string) => getRoom(roomId),
  isBotEnabled: (botId: string) => getBot(botId)?.enabled === true,
  readState: (roomId: string) => roomFileStore.readRelayState(roomId),
  writeState: (roomId: string, state: RoomRelayState) => roomFileStore.writeRelayState(roomId, state),
  now: () => Date.now(),
  uuid: () => randomUUID(),
};

/** Server-only capability. The route accepts only the returned opaque envelope, never its fields. */
export function issueRoomRelayEnvelope(roomId: string, sourceBotId: string, targetBotIds: string[], parentId?: string): string | undefined {
  return issueRelayEnvelope({ roomId, sourceBotId, targetBotIds, parentId }, relayDeps);
}

/** Validate then claim: single-use, durable across workers/restarts. */
export function consumeRoomRelayEnvelope(roomId: string, token: string): Omit<RoomRelayEnvelope, "parentId" | "consumed" | "expiresAt"> | undefined {
  return consumeRelayEnvelope({ roomId, token }, relayDeps);
}

/** Serialize room and relay read/check/write operations across workers. */
export function withRoomLock<T>(roomId: string, action: () => T): T {
  const lockPath = roomLockPath(roomId);
  return withDirectoryLock({
    lockPath,
    parentDir: roomsRoot(),
    staleMs: 30_000,
    busyMessage: "room file is busy",
  }, action);
}

function roomsRoot(): string { return join(dataDir(), "bots", "rooms"); }
function isValidId(id: string): boolean { return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id); }
// File persistence lives in backend core; the shared DTO vocabulary and the
// process-local event bus stay here as injected hooks.
const roomFileStore = new RoomFileStore({
  roomsRoot: () => roomsRoot(),
  handoffStates: ROOM_HANDOFF_STATES,
  onWritten: (room) => roomEvents.emit(room.id, room),
});

function assertId(id: string): void {
  if (!isValidId(id)) throw Object.assign(new Error("invalid room id"), { status: 400 });
}
function roomPath(id: string): string { return roomFileStore.roomPath(id); }
function readRoom(id: string): RoomDto | undefined { return roomFileStore.readRoom(id); }
function writeRoom(room: RoomDto): void { roomFileStore.writeRoom(room); }
function validMembers(members: string[]): string[] {
  return [...new Set(members)].filter((id) => Boolean(getBot(id)));
}

/** Reject unknown bot IDs so a PATCH cannot silently shrink the member list. */
export function assertKnownRoomMembers(members: string[]): string[] {
  const unique = [...new Set(members)];
  const missing = unique.filter((id) => !getBot(id));
  if (missing.length > 0) {
    throw Object.assign(new Error(`不明な Bot が含まれています: ${missing.join(", ")}`), {
      status: 400,
    });
  }
  return unique;
}

export function listRooms(): RoomDto[] {
  return roomFileStore.listRooms();
}
export function getRoom(id: string): RoomDto | undefined { return readRoom(id); }
export function createRoom(input: { name?: string; members?: string[] }): RoomDto {
  assertConfigurationOwner();
  const now = new Date().toISOString();
  const room: RoomDto = { id: randomUUID(), name: input.name?.trim() || "New room", members: validMembers(input.members ?? []), botRelayEnabled: false, createdAt: now, updatedAt: now, messages: [] };
  writeRoom(room);
  return room;
}
export function patchRoom(id: string, patch: { name?: string; members?: string[]; botRelayEnabled?: boolean; codeAutoApprove?: boolean; resetMessages?: boolean }): RoomDto | undefined {
  assertConfigurationOwner();
  return withRoomLock(id, () => {
    const room = readRoom(id);
    if (!room) return undefined;
    if (patch.name !== undefined) room.name = patch.name.trim() || room.name;
    if (patch.members !== undefined) room.members = assertKnownRoomMembers(patch.members);
    if (patch.botRelayEnabled !== undefined) room.botRelayEnabled = patch.botRelayEnabled;
    if (patch.codeAutoApprove !== undefined) room.codeAutoApprove = patch.codeAutoApprove;
    if (patch.resetMessages) { room.messages = []; delete room.lastOutcome; delete room.handoffs; }
    room.updatedAt = new Date().toISOString();
    writeRoom(room);
    return room;
  });
}
/** Remove one member under the room lock so concurrent membership edits are preserved. */
export function removeRoomMember(id: string, memberId: string): RoomDto | undefined {
  return withRoomLock(id, () => {
    const room = readRoom(id);
    if (!room) return undefined;
    const members = room.members.filter((member) => member !== memberId);
    if (members.length === room.members.length) return room;
    room.members = members;
    room.updatedAt = new Date().toISOString();
    writeRoom(room);
    return room;
  });
}
export function deleteRoom(id: string): boolean {
  assertConfigurationOwner();
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
function archiveOverflow(room: RoomDto): void { roomFileStore.archiveOverflow(room); }
type RoomMessageInput = Omit<RoomMessage, "id" | "createdAt"> & { id?: string; createdAt?: number };
function appendRoomMessageLocked(room: RoomDto, message: RoomMessageInput): RoomMessage {
  const existing = message.id ? room.messages.find((item) => item.id === message.id) : undefined;
  if (existing) return existing;
  const next: RoomMessage = { ...message, id: message.id ?? randomUUID(), createdAt: message.createdAt ?? Date.now() };
  room.messages.push(next);
  archiveOverflow(room);
  room.updatedAt = new Date().toISOString();
  writeRoom(room);
  return next;
}
export function appendRoomMessage(id: string, message: RoomMessageInput): RoomMessage | undefined {
  return appendRoomMessageIf(id, () => true, message);
}
/** Append only while the caller's predicate still holds under the room lock. */
export function appendRoomMessageIf(id: string, predicate: (room: RoomDto) => boolean, message: RoomMessageInput): RoomMessage | undefined {
  return withRoomLock(id, () => {
    const room = readRoom(id);
    if (!room || !predicate(room)) return undefined;
    return appendRoomMessageLocked(room, message);
  });
}
type RoomMessagePatch = Partial<Pick<RoomMessage, "text" | "status" | "botName" | "conversation" | "codeRequestId" | "codeTaskId" | "codeState" | "codeRequests" | "codeActivity" | "images" | "files" | "handoffs" | "openerReason">>;
export function updateRoomMessage(id: string, messageId: string, patch: RoomMessagePatch | ((message: RoomMessage) => RoomMessagePatch)): RoomMessage | undefined {
  return withRoomLock(id, () => {
    const room = readRoom(id);
    const message = room?.messages.find((item) => item.id === messageId);
    if (!room || !message) return undefined;
    Object.assign(message, typeof patch === "function" ? patch(message) : patch);
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
/** Mutate the room's registered handoff records atomically; callers mirror display state themselves. */
export function updateRoomHandoffs(id: string, update: (handoffs: RoomHandoff[]) => RoomHandoff[]): RoomHandoff[] | undefined {
  return withRoomLock(id, () => {
    const room = readRoom(id);
    if (!room) return undefined;
    room.handoffs = update(room.handoffs ?? []);
    if (room.handoffs.length === 0) delete room.handoffs;
    room.updatedAt = new Date().toISOString();
    writeRoom(room);
    return room.handoffs;
  });
}
/**
 * Attachments live beside the room file, never inside it: the transcript is rewritten on every
 * turn, so inlined base64 would be re-serialised hundreds of times and shipped on every snapshot.
 */
const ROOM_IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_ROOM_IMAGES = 8;
const MAX_ROOM_IMAGE_BYTES = 8 * 1024 * 1024;
function roomImagePath(roomId: string, file: string): string { return roomFileStore.roomImagePath(roomId, file); }
/** Reject at the boundary: a dropped attachment must not look like a delivered one. */
export function roomImageRejection(images: PromptImageInput[]): string | undefined {
  if (images.length > MAX_ROOM_IMAGES) return `画像は${MAX_ROOM_IMAGES}件までです`;
  if (!isPromptImagesWithinTotalSize(images)) return `画像は合計${MAX_PROMPT_IMAGE_TOTAL_BYTES / 1024 / 1024}MBまでです`;
  for (const image of images) {
    if (!ROOM_IMAGE_EXTENSIONS[image.mimeType.toLowerCase()]) return `対応していない画像形式です: ${image.mimeType}`;
    const bytes = Buffer.byteLength(image.data, "base64");
    if (bytes === 0) return "画像データが空です";
    if (bytes > MAX_ROOM_IMAGE_BYTES) return `画像は1件${MAX_ROOM_IMAGE_BYTES / 1024 / 1024}MBまでです`;
    if (!isPromptImageWithinSize(image)) return "画像データが不正です";
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
  return roomFileStore.readRoomImage(roomId, file);
}

const MAX_ROOM_FILES = 8;
const MAX_ROOM_FILE_BYTES = 8 * 1024 * 1024;
function roomFilePath(roomId: string, file: string): string { return roomFileStore.roomFilePath(roomId, file); }
export function roomFileRejection(files: PromptFileInput[]): string | undefined {
  if (files.length > MAX_ROOM_FILES) return `ファイルは${MAX_ROOM_FILES}件までです`;
  if (!isPromptFilesWithinTotalSize(files)) return `添付ファイルは合計${MAX_PROMPT_FILE_TOTAL_BYTES / 1024}KiBまでです`;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.data, "base64");
    if (bytes === 0) return "ファイルデータが空です";
    if (bytes > MAX_ROOM_FILE_BYTES) return "ファイルは1件8MBまでです";
    if (!isPromptFileWithinSize(file)) return "ファイルデータが不正です";
    if (!isPromptFileText(file)) return "添付ファイルはUTF-8テキストのみ対応しています";
  }
  return undefined;
}
export function saveRoomFiles(roomId: string, messageId: string, files: PromptFileInput[]): RoomFile[] {
  assertId(roomId);
  assertId(messageId);
  mkdirSync(join(roomDataRoot(roomId), "files"), { recursive: true });
  return files.slice(0, MAX_ROOM_FILES).flatMap((file, index) => {
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_ROOM_FILE_BYTES || !isPromptFileText(file)) return [];
    const filename = `${messageId}-${index}.dat`;
    writeFileSync(roomFilePath(roomId, filename), bytes);
    return [{ file: filename, mimeType: file.mimeType, name: file.name, size: bytes.length }];
  });
}
export function readRoomFile(roomId: string, file: string): { bytes: Buffer } | undefined {
  return roomFileStore.readRoomFile(roomId, file);
}
/** Attachments of a request, read back for the model. Turns after the first already have them in session. */
export function roomRequestImages(roomId: string, messageId: string): PromptImageInput[] {
  const message = getRoom(roomId)?.messages.find((item) => item.id === messageId);
  return (message?.images ?? []).flatMap((image) => {
    const stored = readRoomImage(roomId, image.file);
    return stored ? [{ mimeType: stored.mimeType, data: stored.bytes.toString("base64") }] : [];
  });
}
export function roomRequestFiles(roomId: string, messageId: string): PromptFileInput[] {
  const message = getRoom(roomId)?.messages.find((item) => item.id === messageId);
  return (message?.files ?? []).flatMap((file) => {
    const stored = readRoomFile(roomId, file.file);
    return stored ? [{ name: file.name, mimeType: file.mimeType, data: stored.bytes.toString("base64") }] : [];
  });
}

/**
 * Drop a user request and everything said after it, returning its text for the composer.
 * Bot sessions keep their own history: only the shared room transcript is rewound.
 */
export function revertRoomTo(id: string, messageId: string): { text: string; requestId: string; requestIds: string[]; images: RoomImage[]; files: RoomFile[] } | undefined {
  return withRoomLock(id, () => {
    const room = readRoom(id);
    const index = room?.messages.findIndex((item) => item.id === messageId) ?? -1;
    const target = index >= 0 ? room!.messages[index] : undefined;
    if (!room || !target || target.role !== "user") return undefined;
    const removedRequestIds = new Set(room.messages.slice(index).filter((message) => message.role === "user").map((message) => message.id));
    room.messages = room.messages.slice(0, index);
    if (room.lastOutcome && removedRequestIds.has(room.lastOutcome.requestId)) delete room.lastOutcome;
    if (room.handoffs?.length) {
      room.handoffs = room.handoffs.map((handoff) => removedRequestIds.has(handoff.requestId) && (handoff.state === "waiting" || handoff.state === "ready" || handoff.state === "running")
        ? { ...handoff, state: "cancelled", reason: "会話が巻き戻されたため実行しません", updatedAt: Date.now() }
        : handoff);
    }
    room.updatedAt = new Date().toISOString();
    writeRoom(room);
    return {
      text: target.text,
      requestId: messageId,
      requestIds: [...removedRequestIds],
      images: [...(target.images ?? [])],
      files: [...(target.files ?? [])],
    };
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
