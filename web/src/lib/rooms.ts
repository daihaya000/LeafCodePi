import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { dataDir } from "./paths";
import { botTaskId, botWorkspace, getBot, listBots } from "./bots";
import { deleteTask, getTask, insertBotTask, listTasks, patchTask } from "./store";
import { ROOM_HANDOFF_STATES } from "./types";
import type { BotDto, RoomDto, RoomFile, RoomHandoff, RoomImage, RoomMessage, RoomOutcome } from "./types";
import { isPromptFileText, isPromptFileWithinSize, isPromptImageWithinSize, type PromptFileInput, type PromptImageInput } from "./prompt-images";
const roomEvents = new EventEmitter();

/** Per-room data directory: archived history and attachments live here. */
function roomDataRoot(roomId: string): string { return join(roomsRoot(), roomId); }
function roomLockPath(roomId: string): string { assertId(roomId); return join(roomsRoot(), `${roomId}.lock`); }

export const MAX_ROOM_RELAY_DEPTH = 3;
type RoomRelayEnvelope = { roomId: string; sourceBotId: string; targetBotIds: string[]; turnId: string; depth: number; parentId?: string; consumed: boolean; expiresAt: number };
type RoomRelayState = { envelopes: Record<string, RoomRelayEnvelope>; claims: Record<string, string[]> };
const RELAY_ENVELOPE_TTL_MS = 10 * 60 * 1000;

function relayStatePath(roomId: string): string { assertId(roomId); return join(roomDataRoot(roomId), "relay.json"); }
function readRelayState(roomId: string): RoomRelayState {
  try {
    const value = JSON.parse(readFileSync(relayStatePath(roomId), "utf8")) as Partial<RoomRelayState>;
    const envelopes = value.envelopes && typeof value.envelopes === "object" ? value.envelopes : {};
    const claims = value.claims && typeof value.claims === "object" ? value.claims : {};
    return { envelopes: envelopes as Record<string, RoomRelayEnvelope>, claims: claims as Record<string, string[]> };
  } catch { return { envelopes: {}, claims: {} }; }
}
function writeRelayState(roomId: string, state: RoomRelayState): void {
  mkdirSync(roomDataRoot(roomId), { recursive: true });
  const path = relayStatePath(roomId);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  // Rename is atomic on the room's local filesystem, so a restart never sees
  // a half-written claim/envelope file.
  renameSync(temporary, path);
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
  return withRoomLock(roomId, () => {
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

/** Validate then claim: single-use, durable across workers/restarts. */
export function consumeRoomRelayEnvelope(roomId: string, token: string): Omit<RoomRelayEnvelope, "parentId" | "consumed" | "expiresAt"> | undefined {
  return withRoomLock(roomId, () => {
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

/** Serialize room and relay read/check/write operations across workers. */
export function withRoomLock<T>(roomId: string, action: () => T): T {
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
function normalizeRoom(value: Partial<RoomDto>, id: string): RoomDto | null {
  if (value.id !== id || typeof value.name !== "string" || !Array.isArray(value.members)) return null;
  const messages = Array.isArray(value.messages) ? value.messages.filter((item): item is RoomMessage => Boolean(item && typeof item === "object" && typeof item.id === "string" && (item.role === "user" || item.role === "assistant") && typeof item.text === "string" && typeof item.createdAt === "number" && (!("files" in item) || (Array.isArray(item.files) && item.files.every((file) => Boolean(file && typeof file === "object" && typeof file.file === "string" && typeof file.name === "string" && typeof file.mimeType === "string" && typeof file.size === "number")))))) : [];
  const lastOutcome = normalizeOutcome(value.lastOutcome);
  const isHandoff = (item: unknown): item is RoomHandoff => {
    const handoff = item as RoomHandoff | undefined;
    return Boolean(handoff && typeof handoff === "object" && typeof handoff.id === "string" && typeof handoff.requestId === "string"
      && typeof handoff.fromMessageId === "string" && typeof handoff.fromBotId === "string" && typeof handoff.toBotId === "string"
      && typeof handoff.task === "string" && ROOM_HANDOFF_STATES.includes(handoff.state) && typeof handoff.createdAt === "number");
  };
  const handoffs = Array.isArray(value.handoffs) ? value.handoffs.filter(isHandoff) : [];
  return {
    id,
    name: value.name,
    members: [...new Set(value.members.filter((item): item is string => typeof item === "string"))],
    botRelayEnabled: value.botRelayEnabled === true,
    ...(value.codeAutoApprove === true ? { codeAutoApprove: true } : {}),
    ...(lastOutcome ? { lastOutcome } : {}),
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
    messages,
    ...(handoffs.length > 0 ? { handoffs } : {}),
  };
}
function readRoom(id: string): RoomDto | undefined {
  try { return normalizeRoom(JSON.parse(readFileSync(roomPath(id), "utf8")) as Partial<RoomDto>, id) ?? undefined; } catch { return undefined; }
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
  const room: RoomDto = { id: randomUUID(), name: input.name?.trim() || "New room", members: validMembers(input.members ?? []), botRelayEnabled: false, createdAt: now, updatedAt: now, messages: [] };
  writeRoom(room);
  return room;
}
export function patchRoom(id: string, patch: { name?: string; members?: string[]; botRelayEnabled?: boolean; codeAutoApprove?: boolean; resetMessages?: boolean }): RoomDto | undefined {
  return withRoomLock(id, () => {
    const room = readRoom(id);
    if (!room) return undefined;
    if (patch.name !== undefined) room.name = patch.name.trim() || room.name;
    if (patch.members !== undefined) room.members = validMembers(patch.members);
    if (patch.botRelayEnabled !== undefined) room.botRelayEnabled = patch.botRelayEnabled;
    if (patch.codeAutoApprove !== undefined) room.codeAutoApprove = patch.codeAutoApprove;
    if (patch.resetMessages) { room.messages = []; delete room.lastOutcome; delete room.handoffs; }
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
type RoomMessagePatch = Partial<Pick<RoomMessage, "text" | "status" | "botName" | "conversation" | "codeRequestId" | "codeTaskId" | "codeState" | "codeRequests" | "codeActivity" | "images" | "files" | "handoffs">>;
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
  try {
    const mimeType = Object.entries(ROOM_IMAGE_EXTENSIONS).find(([, extension]) => file.toLowerCase().endsWith(`.${extension}`))?.[0];
    return mimeType ? { bytes: readFileSync(roomImagePath(roomId, file)), mimeType } : undefined;
  } catch { return undefined; }
}

const ROOM_FILE_PATTERN = /^[0-9a-f-]{36}-\d{1,2}\.dat$/i;
const MAX_ROOM_FILES = 8;
const MAX_ROOM_FILE_BYTES = 8 * 1024 * 1024;
function roomFilePath(roomId: string, file: string): string {
  assertId(roomId);
  if (!ROOM_FILE_PATTERN.test(file)) throw new Error("invalid room file");
  return join(roomDataRoot(roomId), "files", file);
}
export function roomFileRejection(files: PromptFileInput[]): string | undefined {
  if (files.length > MAX_ROOM_FILES) return `ファイルは${MAX_ROOM_FILES}件までです`;
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
  try { return { bytes: readFileSync(roomFilePath(roomId, file)) }; } catch { return undefined; }
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
