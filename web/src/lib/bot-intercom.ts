import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { botWorkspace, getBot, listBots } from "@/lib/bots";
import { dataDir, samePath } from "@/lib/paths";
import {
  isPromptFileText,
  isPromptFileWithinSize,
  type PromptFileInput,
  type PromptImageInput,
} from "@/lib/prompt-images";
import { MAX_ROOM_RELAY_DEPTH, roomFileRejection, roomImageRejection } from "@/lib/rooms";
import {
  BOT_INTERCOM_SCHEMA_VERSION,
  type BotIntercomAttachmentMeta,
  type BotIntercomDelivery,
  type BotIntercomInboxDto,
  type BotIntercomInboxItemDto,
  type BotIntercomMessageKind,
  type BotIntercomMessageV1,
  type BotIntercomPeerPresenceDto,
  type BotIntercomPendingAskDto,
  type BotIntercomPresence,
} from "@/lib/types";

export { BOT_INTERCOM_SCHEMA_VERSION };
export type {
  BotIntercomAttachmentMeta,
  BotIntercomDelivery,
  BotIntercomInboxDto,
  BotIntercomInboxItemDto,
  BotIntercomMessageV1,
  BotIntercomPeerPresenceDto,
  BotIntercomPendingAskDto,
  BotIntercomPresence,
};

/** Same hop budget as Room relay (`MAX_ROOM_RELAY_DEPTH`). */
export const MAX_BOT_INTERCOM_DEPTH = MAX_ROOM_RELAY_DEPTH;
/** Same-thread ask/reply round-trips share the Room hop budget. */
export const MAX_BOT_INTERCOM_ASK_ROUNDTRIPS = MAX_BOT_INTERCOM_DEPTH;
/** Empty / missing Bot `intercomScopeId` shares this implicit workspace. */
export const DEFAULT_BOT_INTERCOM_SCOPE_ID = "default";
/** Guarded fanout recipient cap. */
export const MAX_BOT_INTERCOM_FANOUT = 8;
/**
 * Fanout is a single hop (no amplify). Nested fanout is rejected.
 * Pair 1:1 depth still uses `MAX_BOT_INTERCOM_DEPTH`.
 */
export const MAX_BOT_INTERCOM_FANOUT_DEPTH = 0;

export const BOT_INTERCOM_MESSAGE_MAX = 2_000;
export const BOT_INTERCOM_MAILBOX_MAX = 256;
export const BOT_INTERCOM_ASK_TIMEOUT_MS = 10 * 60 * 1000;

const INTERCOM_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type BotIntercomPeerDto = {
  id: string;
  name: string;
  resident: boolean;
  intercomEnabled: boolean;
  presence: BotIntercomPresence;
  scopeId: string;
  fanoutEnabled: boolean;
};

export type BotIntercomAttachmentInput = {
  name?: string;
  mimeType: string;
  data: string;
};

export type SendBotIntercomInput = {
  /** Server-derived sender. Callers must never take this from tool arguments. */
  fromBotId: string;
  to: string;
  text: string;
  /** Room turns keep formal @ on room_handoff; the DM path must not run. */
  roomTurn?: boolean;
  attachments?: BotIntercomAttachmentInput[];
  supersedes?: string;
  retryOf?: string;
};

export type AskBotIntercomInput = SendBotIntercomInput & {
  signal?: AbortSignal;
};

export type ReplyBotIntercomInput = {
  fromBotId: string;
  text: string;
  to?: string;
  replyTo?: string;
  roomTurn?: boolean;
  attachments?: BotIntercomAttachmentInput[];
};

export type CancelBotIntercomInput = {
  fromBotId: string;
  messageId: string;
  roomTurn?: boolean;
};

export type FanoutBotIntercomInput = {
  fromBotId: string;
  to: string[];
  text: string;
  roomTurn?: boolean;
  attachments?: BotIntercomAttachmentInput[];
};

type PairThread = {
  id: string;
  lastFrom: string;
  lastTo: string;
  depth: number;
  askRoundTrips: number;
};

type PendingAskRecord = {
  id: string;
  conversationId: string;
  fromBotId: string;
  toBotId: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  depth: number;
};

type InboxState = {
  messages: BotIntercomMessageV1[];
  lastReadAt: number;
  pendingAsks: PendingAskRecord[];
};

type AskWaiter = {
  fromBotId: string;
  resolve: (reply: BotIntercomMessageV1) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

const inboxEvents = new EventEmitter();
inboxEvents.setMaxListeners(0);

const inboxes = new Map<string, InboxState>();
const threads = new Map<string, PairThread>();
const pendingAsks = new Map<string, PendingAskRecord>();
const waiters = new Map<string, AskWaiter>();
const waitingBots = new Set<string>();

let threadsLoaded = false;
let residentLookup: (botId: string) => boolean = () => false;
let busyLookup: (botId: string) => boolean = () => false;
let steerHandler: ((message: BotIntercomMessageV1) => void | Promise<void>) | null =
  null;
let askTimeoutMs = BOT_INTERCOM_ASK_TIMEOUT_MS;

const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

/** Harness installs this so "resident" means a live 1:1 session (`bot:<id>`). */
export function setBotIntercomResidentLookup(lookup: (botId: string) => boolean): void {
  residentLookup = lookup;
}

/** Harness installs this so "busy" means the 1:1 session is prompting / streaming. */
export function setBotIntercomBusyLookup(lookup: (botId: string) => boolean): void {
  busyLookup = lookup;
}

/** Harness steers a live busy session when delivery is labeled "steered". */
export function setBotIntercomSteerHandler(
  handler: ((message: BotIntercomMessageV1) => void | Promise<void>) | null,
): void {
  steerHandler = handler;
}

export function isBotIntercomResident(botId: string): boolean {
  return residentLookup(botId);
}

export function botIntercomPresence(botId: string): BotIntercomPresence {
  if (!isBotIntercomResident(botId)) return "offline";
  if (waitingBots.has(botId) || busyLookup(botId)) return "busy";
  return "online";
}

export function setBotIntercomAskTimeoutMsForTests(ms: number): void {
  askTimeoutMs = ms;
}

export function subscribeBotIntercomInbox(botId: string, listener: (inbox: BotIntercomInboxDto) => void): () => void {
  const handler = (inbox: BotIntercomInboxDto) => listener(inbox);
  inboxEvents.on(botId, handler);
  return () => {
    inboxEvents.off(botId, handler);
  };
}

export function resetBotIntercomForTests(): void {
  for (const waiter of waiters.values()) {
    clearTimeout(waiter.timer);
    waiter.abort?.();
    waiter.reject(new Error("reset"));
  }
  waiters.clear();
  waitingBots.clear();
  pendingAsks.clear();
  inboxes.clear();
  threads.clear();
  threadsLoaded = false;
  inboxEvents.removeAllListeners();
  residentLookup = () => false;
  busyLookup = () => false;
  steerHandler = null;
  askTimeoutMs = BOT_INTERCOM_ASK_TIMEOUT_MS;
}

function isBotId(id: string): boolean {
  return BOT_ID_RE.test(id);
}

function mailboxPath(botId: string): string {
  return join(dataDir(), "bots", botId, "intercom", "mailbox.json");
}

function threadsPath(): string {
  return join(dataDir(), "bots", ".intercom", "threads.json");
}

function attachmentsDir(): string {
  return join(dataDir(), "bots", ".intercom", "attachments");
}

function atomicWrite(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  renameSync(temporary, file);
}

function asDelivery(value: unknown): BotIntercomDelivery | undefined {
  if (value === "delivered" || value === "queued" || value === "steered" || value === "cancelled" || value === "superseded") {
    return value;
  }
  return undefined;
}

function asAttachmentMeta(value: unknown): BotIntercomAttachmentMeta | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<BotIntercomAttachmentMeta>;
  if (row.kind !== "image" && row.kind !== "file") return null;
  if (typeof row.name !== "string" || typeof row.mimeType !== "string" || typeof row.file !== "string") return null;
  if (typeof row.bytes !== "number") return null;
  return { kind: row.kind, name: row.name, mimeType: row.mimeType, file: row.file, bytes: row.bytes };
}

function asMessage(value: unknown): BotIntercomMessageV1 | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<BotIntercomMessageV1>;
  if (row.v !== BOT_INTERCOM_SCHEMA_VERSION) return null;
  if (typeof row.id !== "string" || typeof row.fromBotId !== "string" || typeof row.toBotId !== "string") return null;
  if (typeof row.text !== "string" || typeof row.createdAt !== "number" || typeof row.depth !== "number") return null;
  const kind = row.kind === "ask" || row.kind === "reply" || row.kind === "send" ? row.kind : undefined;
  const delivery = asDelivery(row.delivery);
  const attachments = Array.isArray(row.attachments)
    ? row.attachments.map(asAttachmentMeta).filter((item): item is BotIntercomAttachmentMeta => Boolean(item))
    : undefined;
  return {
    v: BOT_INTERCOM_SCHEMA_VERSION,
    id: row.id,
    fromBotId: row.fromBotId,
    toBotId: row.toBotId,
    text: row.text,
    createdAt: row.createdAt,
    depth: row.depth,
    ...(kind ? { kind } : {}),
    ...(typeof row.conversationId === "string" ? { conversationId: row.conversationId } : {}),
    ...(typeof row.replyTo === "string" ? { replyTo: row.replyTo } : {}),
    ...(row.queued === true ? { queued: true } : {}),
    ...(delivery ? { delivery } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(typeof row.supersedes === "string" ? { supersedes: row.supersedes } : {}),
    ...(typeof row.supersededBy === "string" ? { supersededBy: row.supersededBy } : {}),
    ...(typeof row.retryOf === "string" ? { retryOf: row.retryOf } : {}),
    ...(row.cancelled === true ? { cancelled: true } : {}),
    ...(typeof row.scopeId === "string" ? { scopeId: row.scopeId } : {}),
    ...(row.fanout === true ? { fanout: true } : {}),
    ...(typeof row.fanoutDepth === "number" ? { fanoutDepth: row.fanoutDepth } : {}),
  };
}

function asPending(value: unknown): PendingAskRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<PendingAskRecord>;
  if (typeof row.id !== "string" || typeof row.conversationId !== "string") return null;
  if (typeof row.fromBotId !== "string" || typeof row.toBotId !== "string" || typeof row.text !== "string") return null;
  if (typeof row.createdAt !== "number" || typeof row.expiresAt !== "number" || typeof row.depth !== "number") return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    fromBotId: row.fromBotId,
    toBotId: row.toBotId,
    text: row.text,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    depth: row.depth,
  };
}

function persistMailbox(botId: string, state: InboxState): void {
  if (!isBotId(botId)) return;
  atomicWrite(mailboxPath(botId), {
    v: BOT_INTERCOM_SCHEMA_VERSION,
    lastReadAt: state.lastReadAt,
    messages: state.messages,
    pendingAsks: state.pendingAsks,
  });
}

function persistThreads(): void {
  atomicWrite(threadsPath(), {
    v: BOT_INTERCOM_SCHEMA_VERSION,
    threads: [...threads.values()].map((thread) => ({
      id: thread.id,
      lastFrom: thread.lastFrom,
      lastTo: thread.lastTo,
      depth: thread.depth,
      askRoundTrips: thread.askRoundTrips,
    })),
  });
}

function ensureThreadsLoaded(): void {
  if (threadsLoaded) return;
  threadsLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(threadsPath(), "utf8")) as { threads?: unknown };
    if (!Array.isArray(parsed.threads)) return;
    for (const row of parsed.threads) {
      if (!row || typeof row !== "object") continue;
      const thread = row as Partial<PairThread>;
      if (typeof thread.id !== "string" || typeof thread.lastFrom !== "string" || typeof thread.lastTo !== "string") continue;
      if (typeof thread.depth !== "number") continue;
      threads.set(pairKey(thread.lastFrom, thread.lastTo), {
        id: thread.id,
        lastFrom: thread.lastFrom,
        lastTo: thread.lastTo,
        depth: thread.depth,
        askRoundTrips: typeof thread.askRoundTrips === "number" ? thread.askRoundTrips : 0,
      });
    }
  } catch {
    /* first run or empty */
  }
}

function loadMailbox(botId: string): InboxState {
  const empty: InboxState = { messages: [], lastReadAt: 0, pendingAsks: [] };
  if (!isBotId(botId)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(mailboxPath(botId), "utf8")) as {
      lastReadAt?: unknown;
      messages?: unknown;
      pendingAsks?: unknown;
    };
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.map(asMessage).filter((message): message is BotIntercomMessageV1 => Boolean(message))
      : [];
    const now = Date.now();
    const records = Array.isArray(parsed.pendingAsks)
      ? parsed.pendingAsks.map(asPending).filter((row): row is PendingAskRecord => row !== null && row.expiresAt > now)
      : [];
    for (const record of records) pendingAsks.set(record.id, record);
    return {
      messages,
      lastReadAt: typeof parsed.lastReadAt === "number" ? parsed.lastReadAt : 0,
      pendingAsks: records,
    };
  } catch {
    return empty;
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function inboxState(botId: string): InboxState {
  const existing = inboxes.get(botId);
  if (existing) return existing;
  const created = existsSync(mailboxPath(botId)) ? loadMailbox(botId) : { messages: [], lastReadAt: 0, pendingAsks: [] };
  inboxes.set(botId, created);
  return created;
}

function previewText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(compact);
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : compact;
}

function toInboxItem(message: BotIntercomMessageV1): BotIntercomInboxItemDto {
  return {
    ...message,
    fromName: getBot(message.fromBotId)?.name ?? "不明なBot",
  };
}

function toPendingDto(record: PendingAskRecord): BotIntercomPendingAskDto {
  return {
    id: record.id,
    conversationId: record.conversationId,
    fromBotId: record.fromBotId,
    fromName: getBot(record.fromBotId)?.name ?? "不明なBot",
    text: record.text,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function emitInbox(botId: string): BotIntercomInboxDto {
  const inbox = getBotIntercomInbox(botId);
  inboxEvents.emit(botId, inbox);
  return inbox;
}

function appendMailbox(botId: string, message: BotIntercomMessageV1): void {
  const state = inboxState(botId);
  state.messages.push(message);
  while (state.messages.length > BOT_INTERCOM_MAILBOX_MAX) state.messages.shift();
  persistMailbox(botId, state);
}

function deliverToMailboxes(message: BotIntercomMessageV1): void {
  appendMailbox(message.toBotId, message);
  if (message.fromBotId !== message.toBotId) appendMailbox(message.fromBotId, message);
  emitInbox(message.toBotId);
  if (message.fromBotId !== message.toBotId) emitInbox(message.fromBotId);
  if (message.delivery !== "steered" || !steerHandler) return;
  void Promise.resolve(steerHandler(message)).catch((error) => {
    console.warn(
      "[bot-intercom] steer failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
}

function isActiveInboxMessage(message: BotIntercomMessageV1): boolean {
  return message.cancelled !== true && !message.supersededBy;
}

function counterpartPresence(botId: string, messages: BotIntercomMessageV1[]): BotIntercomPeerPresenceDto | null {
  const latest = messages[messages.length - 1];
  if (!latest) return null;
  const otherId = latest.fromBotId === botId ? latest.toBotId : latest.fromBotId;
  const other = getBot(otherId);
  if (!other) return null;
  return { botId: otherId, name: other.name, status: botIntercomPresence(otherId) };
}

export function getBotIntercomInbox(botId: string): BotIntercomInboxDto {
  pruneExpiredAsks(botId);
  const state = inboxState(botId);
  const messages = state.messages.map(toInboxItem);
  const unreadCount = messages.filter((message) => (
    message.toBotId === botId
    && message.createdAt > state.lastReadAt
    && isActiveInboxMessage(message)
  )).length;
  const latest = [...messages].reverse().find((message) => message.toBotId === botId) ?? messages[messages.length - 1];
  return {
    messages,
    unreadCount,
    preview: latest
      ? {
          fromBotId: latest.fromBotId,
          fromName: latest.fromName,
          text: previewText(latest.text || (latest.attachments?.length ? latest.attachments[0]!.name : "")),
          createdAt: latest.createdAt,
          ...(latest.kind ? { kind: latest.kind } : {}),
        }
      : null,
    pendingAsks: state.pendingAsks.map(toPendingDto),
    peerPresence: counterpartPresence(botId, state.messages),
  };
}

export function markBotIntercomInboxRead(botId: string, readAt = Date.now()): BotIntercomInboxDto {
  const state = inboxState(botId);
  const inbound = state.messages.filter((message) => message.toBotId === botId);
  const latest = inbound[inbound.length - 1]?.createdAt ?? readAt;
  state.lastReadAt = Math.max(state.lastReadAt, readAt, latest);
  persistMailbox(botId, state);
  return emitInbox(botId);
}

export function listBotIntercomPeers(fromBotId: string, options?: { cwd?: string }): BotIntercomPeerDto[] {
  const fromScope = botIntercomScopeId(getBot(fromBotId));
  const cwd = options?.cwd?.trim();
  return listBots()
    .filter((bot) => bot.id !== fromBotId && bot.enabled)
    .filter((bot) => botIntercomScopeId(bot) === fromScope)
    .filter((bot) => !cwd || botMatchesIntercomCwd(bot, cwd))
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      resident: isBotIntercomResident(bot.id),
      intercomEnabled: bot.intercomEnabled === true,
      presence: botIntercomPresence(bot.id),
      scopeId: botIntercomScopeId(bot),
      fanoutEnabled: bot.intercomFanoutEnabled === true,
    }));
}

/** Same-scope roster, optionally filtered to a shared extraRoot / workspace path. */
export function listBotIntercomCwdPeers(fromBotId: string, cwd?: string): BotIntercomPeerDto[] {
  const filter = cwd?.trim();
  if (!filter) return listBotIntercomPeers(fromBotId);
  return listBotIntercomPeers(fromBotId, { cwd: filter });
}

export function botIntercomScopeId(bot: { intercomScopeId?: string | null } | undefined): string {
  const trimmed = bot?.intercomScopeId?.trim();
  return trimmed || DEFAULT_BOT_INTERCOM_SCOPE_ID;
}

function botIntercomRoots(bot: { id: string; extraRoots: string[] }): string[] {
  return [botWorkspace(bot.id), ...bot.extraRoots];
}

function botMatchesIntercomCwd(bot: { id: string; extraRoots: string[] }, cwd: string): boolean {
  return botIntercomRoots(bot).some((root) => {
    try {
      return samePath(root, cwd);
    } catch {
      return root === cwd;
    }
  });
}

export function listPendingBotIntercomAsks(botId: string): BotIntercomPendingAskDto[] {
  pruneExpiredAsks(botId);
  return inboxState(botId).pendingAsks.map(toPendingDto);
}

function resolveDestinationBotId(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) throw new Error("Destination must be a Bot id");
  const bot = getBot(trimmed);
  if (!bot) throw new Error("Destination must be a Bot id");
  return bot.id;
}

function assertSendConsent(botId: string, role: "sender" | "recipient"): void {
  const bot = getBot(botId);
  if (!bot?.enabled) throw new Error(role === "sender" ? "Sender Bot is not available" : "Recipient Bot is not available");
  if (bot.intercomEnabled !== true) {
    throw new Error(
      role === "sender"
        ? "Intercom is disabled for this Bot (opt-in setting)"
        : "Recipient has not opted in to intercom",
    );
  }
  if (!(bot.tools ?? []).includes("intercom")) {
    throw new Error(
      role === "sender"
        ? "Intercom is not on this Bot's tool allowlist"
        : "Recipient does not allow the intercom tool",
    );
  }
}

function assertDmAllowed(roomTurn: boolean | undefined): void {
  if (roomTurn) {
    throw new Error("Intercom DM is not available during a Room turn; formal @ stays on room_handoff");
  }
}

function assertSameIntercomScope(fromBotId: string, toBotId: string): void {
  const fromScope = botIntercomScopeId(getBot(fromBotId));
  const toScope = botIntercomScopeId(getBot(toBotId));
  if (fromScope !== toScope) {
    throw new Error("Intercom rejected: destination is out of scope");
  }
}

function nextFanoutDepth(fromBotId: string): number {
  const inbound = inboxState(fromBotId).messages.filter(
    (message) => message.toBotId === fromBotId && isActiveInboxMessage(message),
  );
  const latest = inbound[inbound.length - 1];
  if (!latest?.fanout) return 0;
  return (latest.fanoutDepth ?? 0) + 1;
}

function nextThreadHop(fromBotId: string, toBotId: string): { thread: PairThread; depth: number } {
  ensureThreadsLoaded();
  const key = pairKey(fromBotId, toBotId);
  const current = threads.get(key);
  if (!current) {
    return { thread: { id: randomUUID(), lastFrom: fromBotId, lastTo: toBotId, depth: 0, askRoundTrips: 0 }, depth: 0 };
  }
  if (current.lastTo === fromBotId && current.lastFrom === toBotId) {
    return { thread: current, depth: current.depth + 1 };
  }
  if (current.lastFrom === fromBotId && current.lastTo === toBotId) {
    return { thread: current, depth: current.depth };
  }
  return { thread: { id: randomUUID(), lastFrom: fromBotId, lastTo: toBotId, depth: 0, askRoundTrips: 0 }, depth: 0 };
}

function rememberThread(thread: PairThread, fromBotId: string, toBotId: string, depth: number, askRoundTrips = thread.askRoundTrips): void {
  ensureThreadsLoaded();
  threads.set(pairKey(fromBotId, toBotId), {
    id: thread.id,
    lastFrom: fromBotId,
    lastTo: toBotId,
    depth,
    askRoundTrips,
  });
  persistThreads();
}

function deliveryFor(toBotId: string): BotIntercomDelivery {
  if (!isBotIntercomResident(toBotId)) return "queued";
  if (botIntercomPresence(toBotId) === "busy") return "steered";
  return "delivered";
}

function normalizeAttachmentInputs(inputs: BotIntercomAttachmentInput[]): {
  images: PromptImageInput[];
  files: PromptFileInput[];
} {
  const images: PromptImageInput[] = [];
  const files: PromptFileInput[] = [];
  for (const item of inputs) {
    if (!item || typeof item.mimeType !== "string" || typeof item.data !== "string") {
      throw new Error("添付の形式が不正です");
    }
    const mime = item.mimeType.toLowerCase();
    if (mime.startsWith("image/")) {
      if (!INTERCOM_IMAGE_EXTENSIONS[mime]) {
        throw new Error(`対応していない画像形式です: ${item.mimeType}`);
      }
      images.push({ mimeType: mime, data: item.data });
      continue;
    }
    const name = item.name?.trim() || "file.txt";
    files.push({ name, mimeType: item.mimeType, data: item.data });
  }
  return { images, files };
}

function storeAttachments(messageId: string, inputs: BotIntercomAttachmentInput[] | undefined): BotIntercomAttachmentMeta[] {
  if (!inputs || inputs.length === 0) return [];
  if (!BOT_ID_RE.test(messageId)) throw new Error("Invalid message id");
  const { images, files } = normalizeAttachmentInputs(inputs);
  const imageError = roomImageRejection(images);
  if (imageError) throw new Error(imageError);
  const fileError = roomFileRejection(files);
  if (fileError) throw new Error(fileError);
  for (const file of files) {
    if (!isPromptFileWithinSize(file) || !isPromptFileText(file)) {
      throw new Error("添付ファイルはUTF-8テキストのみ対応しています");
    }
  }

  mkdirSync(attachmentsDir(), { recursive: true });
  const stored: BotIntercomAttachmentMeta[] = [];
  let index = 0;
  for (const image of images) {
    const extension = INTERCOM_IMAGE_EXTENSIONS[image.mimeType.toLowerCase()];
    if (!extension) continue;
    const bytes = Buffer.from(image.data, "base64");
    const file = `${messageId}-${index}.${extension}`;
    writeFileSync(join(attachmentsDir(), file), bytes);
    stored.push({
      kind: "image",
      name: `image-${index + 1}.${extension}`,
      mimeType: image.mimeType.toLowerCase(),
      file,
      bytes: bytes.length,
    });
    index += 1;
  }
  for (const fileInput of files) {
    const bytes = Buffer.from(fileInput.data, "base64");
    const file = `${messageId}-${index}.dat`;
    writeFileSync(join(attachmentsDir(), file), bytes);
    stored.push({
      kind: "file",
      name: fileInput.name,
      mimeType: fileInput.mimeType,
      file,
      bytes: bytes.length,
    });
    index += 1;
  }
  return stored;
}

function findOwnedMessage(fromBotId: string, messageId: string): BotIntercomMessageV1 | undefined {
  return inboxState(fromBotId).messages.find((message) => message.id === messageId && message.fromBotId === fromBotId);
}

function patchMessageCopies(messageId: string, patch: (message: BotIntercomMessageV1) => void, botIds: string[]): void {
  const seen = new Set<string>();
  for (const botId of botIds) {
    if (seen.has(botId)) continue;
    seen.add(botId);
    const state = inboxState(botId);
    const message = state.messages.find((item) => item.id === messageId);
    if (!message) continue;
    patch(message);
    persistMailbox(botId, state);
    emitInbox(botId);
  }
}

function assertSupersedeTarget(fromBotId: string, toBotId: string, oldId: string): BotIntercomMessageV1 {
  const trimmed = oldId.trim();
  if (!trimmed) throw new Error("supersedes target not found");
  const old = findOwnedMessage(fromBotId, trimmed);
  if (!old) throw new Error("supersedes target not found");
  if (old.fromBotId !== fromBotId || old.toBotId !== toBotId) {
    throw new Error("supersedes must be the same sender and recipient");
  }
  if (old.cancelled || old.supersededBy) {
    throw new Error("Message already cancelled or superseded");
  }
  return old;
}

function markSuperseded(old: BotIntercomMessageV1, newId: string): void {
  patchMessageCopies(old.id, (message) => {
    message.supersededBy = newId;
    message.delivery = "superseded";
  }, [old.fromBotId, old.toBotId]);
  if (pendingAsks.has(old.id)) {
    detachPendingAsk(old.id);
    rejectWaiter(old.id, new Error(`Superseded (messageId: ${old.id})`));
  }
}

function prepareDelivery(input: SendBotIntercomInput, kind: BotIntercomMessageKind): {
  fromBotId: string;
  toBotId: string;
  text: string;
  hop: { thread: PairThread; depth: number };
  queued: boolean;
  delivery: BotIntercomDelivery;
  attachments: BotIntercomAttachmentInput[] | undefined;
  scopeId: string;
  supersedes?: string;
  retryOf?: string;
} {
  assertDmAllowed(input.roomTurn);
  const text = input.text.trim();
  const attachments = input.attachments && input.attachments.length > 0 ? input.attachments : undefined;
  if (!text && !attachments) throw new Error("Message text is required");
  if (text.length > BOT_INTERCOM_MESSAGE_MAX) throw new Error("Message text is too long");

  const fromBotId = input.fromBotId.trim();
  if (!getBot(fromBotId)) throw new Error("Sender Bot is not available");
  const toBotId = resolveDestinationBotId(input.to);
  if (toBotId === fromBotId) throw new Error("Cannot send intercom to the current Bot");

  assertSendConsent(fromBotId, "sender");
  assertSendConsent(toBotId, "recipient");
  assertSameIntercomScope(fromBotId, toBotId);

  const hop = nextThreadHop(fromBotId, toBotId);
  if (hop.depth > MAX_BOT_INTERCOM_DEPTH) {
    throw new Error("Intercom rejected: maximum depth exceeded");
  }
  if (kind === "ask" && hop.thread.askRoundTrips >= MAX_BOT_INTERCOM_ASK_ROUNDTRIPS) {
    throw new Error("Intercom rejected: maximum ask/reply depth exceeded");
  }

  const delivery = deliveryFor(toBotId);
  return {
    fromBotId,
    toBotId,
    text,
    hop,
    queued: delivery === "queued",
    delivery,
    attachments,
    scopeId: botIntercomScopeId(getBot(fromBotId)),
    ...(input.supersedes?.trim() ? { supersedes: input.supersedes.trim() } : {}),
    ...(input.retryOf?.trim() ? { retryOf: input.retryOf.trim() } : {}),
  };
}

function buildMessage(
  kind: BotIntercomMessageKind,
  fromBotId: string,
  toBotId: string,
  text: string,
  depth: number,
  conversationId: string,
  extras: {
    id?: string;
    replyTo?: string;
    queued?: boolean;
    delivery?: BotIntercomDelivery;
    attachments?: BotIntercomAttachmentMeta[];
    supersedes?: string;
    retryOf?: string;
    scopeId?: string;
    fanout?: boolean;
    fanoutDepth?: number;
  } = {},
): BotIntercomMessageV1 {
  return {
    v: BOT_INTERCOM_SCHEMA_VERSION,
    id: extras.id ?? randomUUID(),
    fromBotId,
    toBotId,
    text,
    createdAt: Date.now(),
    depth,
    kind,
    conversationId,
    ...(extras.replyTo ? { replyTo: extras.replyTo } : {}),
    ...(extras.queued ? { queued: true } : {}),
    ...(extras.delivery ? { delivery: extras.delivery } : {}),
    ...(extras.attachments && extras.attachments.length > 0 ? { attachments: extras.attachments } : {}),
    ...(extras.supersedes ? { supersedes: extras.supersedes } : {}),
    ...(extras.retryOf ? { retryOf: extras.retryOf } : {}),
    ...(extras.scopeId ? { scopeId: extras.scopeId } : {}),
    ...(extras.fanout ? { fanout: true } : {}),
    ...(typeof extras.fanoutDepth === "number" ? { fanoutDepth: extras.fanoutDepth } : {}),
  };
}

function commitOutgoing(
  kind: BotIntercomMessageKind,
  prepared: ReturnType<typeof prepareDelivery>,
  extras: { replyTo?: string; fanout?: boolean; fanoutDepth?: number } = {},
): BotIntercomMessageV1 {
  const superseded = prepared.supersedes
    ? assertSupersedeTarget(prepared.fromBotId, prepared.toBotId, prepared.supersedes)
    : undefined;
  const id = randomUUID();
  const attachments = storeAttachments(id, prepared.attachments);
  const message = buildMessage(
    kind,
    prepared.fromBotId,
    prepared.toBotId,
    prepared.text,
    prepared.hop.depth,
    prepared.hop.thread.id,
    {
      id,
      queued: prepared.queued,
      delivery: prepared.delivery,
      attachments,
      supersedes: prepared.supersedes,
      retryOf: prepared.retryOf,
      replyTo: extras.replyTo,
      scopeId: prepared.scopeId,
      fanout: extras.fanout,
      fanoutDepth: extras.fanoutDepth,
    },
  );
  if (superseded) markSuperseded(superseded, message.id);
  return message;
}

/** Deliver a `send`. Sender identity is only the provided fromBotId. Offline bots are queued. Busy bots are steered. */
export function sendBotIntercom(input: SendBotIntercomInput): BotIntercomMessageV1 {
  const prepared = prepareDelivery(input, "send");
  const message = commitOutgoing("send", prepared);
  rememberThread(prepared.hop.thread, prepared.fromBotId, prepared.toBotId, prepared.hop.depth);
  deliverToMailboxes(message);
  return message;
}

/**
 * Guarded same-scope broadcast. Default off (`intercomFanoutEnabled`).
 * Fail-closed: every Bot id is validated before any mailbox write.
 */
export function fanoutBotIntercom(input: FanoutBotIntercomInput): BotIntercomMessageV1[] {
  assertDmAllowed(input.roomTurn);
  const fromBotId = input.fromBotId.trim();
  const sender = getBot(fromBotId);
  if (!sender) throw new Error("Sender Bot is not available");
  assertSendConsent(fromBotId, "sender");
  if (sender.intercomFanoutEnabled !== true) {
    throw new Error("Fanout is disabled (opt-in setting)");
  }

  const toIds = [...new Set(input.to.map((id) => id.trim()).filter(Boolean))];
  if (toIds.length === 0) throw new Error("Fanout requires at least one Bot id");
  if (toIds.length > MAX_BOT_INTERCOM_FANOUT) {
    throw new Error(`Fanout rejected: maximum recipient count is ${MAX_BOT_INTERCOM_FANOUT}`);
  }

  const fanoutDepth = nextFanoutDepth(fromBotId);
  if (fanoutDepth > MAX_BOT_INTERCOM_FANOUT_DEPTH) {
    throw new Error("Fanout rejected: maximum fanout depth exceeded");
  }

  const preparedList = toIds.map((to) => prepareDelivery({
    fromBotId,
    to,
    text: input.text,
    attachments: input.attachments,
    roomTurn: input.roomTurn,
  }, "send"));

  return preparedList.map((prepared) => {
    const message = commitOutgoing("send", prepared, { fanout: true, fanoutDepth });
    rememberThread(prepared.hop.thread, prepared.fromBotId, prepared.toBotId, prepared.hop.depth);
    deliverToMailboxes(message);
    return message;
  });
}

function pruneExpiredAsks(botId?: string): void {
  const now = Date.now();
  const expired = [...pendingAsks.values()].filter((record) => record.expiresAt <= now && (!botId || record.toBotId === botId || record.fromBotId === botId));
  for (const record of expired) {
    pendingAsks.delete(record.id);
    const recipient = inboxState(record.toBotId);
    recipient.pendingAsks = recipient.pendingAsks.filter((item) => item.id !== record.id);
    persistMailbox(record.toBotId, recipient);
    const waiter = waiters.get(record.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.abort?.();
      waiters.delete(record.id);
      waitingBots.delete(waiter.fromBotId);
      waiter.reject(askTimeoutError(record));
    }
  }
}

function askTimeoutError(record: PendingAskRecord): Error {
  return new Error(`Ask timed out (messageId: ${record.id}, delivery: ${isBotIntercomResident(record.toBotId) ? "delivered" : "queued"})`);
}

function attachPendingAsk(record: PendingAskRecord): void {
  pendingAsks.set(record.id, record);
  const recipient = inboxState(record.toBotId);
  recipient.pendingAsks = [...recipient.pendingAsks.filter((item) => item.id !== record.id), record];
  persistMailbox(record.toBotId, recipient);
  emitInbox(record.toBotId);
}

function detachPendingAsk(askId: string): PendingAskRecord | undefined {
  const record = pendingAsks.get(askId);
  if (!record) return undefined;
  pendingAsks.delete(askId);
  const recipient = inboxState(record.toBotId);
  recipient.pendingAsks = recipient.pendingAsks.filter((item) => item.id !== askId);
  persistMailbox(record.toBotId, recipient);
  emitInbox(record.toBotId);
  return record;
}

function rejectWaiter(askId: string, error: Error): void {
  const waiter = waiters.get(askId);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  waiter.abort?.();
  waiters.delete(askId);
  waitingBots.delete(waiter.fromBotId);
  waiter.reject(error);
}

function resolveAskTarget(fromBotId: string, to?: string, replyTo?: string): PendingAskRecord {
  pruneExpiredAsks(fromBotId);
  const inbound = inboxState(fromBotId).pendingAsks;
  if (replyTo?.trim()) {
    const match = inbound.find((item) => item.id === replyTo.trim());
    if (!match) throw new Error("No pending ask matches replyTo");
    return match;
  }
  const fromPeer = to?.trim() ? inbound.filter((item) => item.fromBotId === resolveDestinationBotId(to)) : inbound;
  if (fromPeer.length === 0) throw new Error("No pending ask");
  if (fromPeer.length > 1) throw new Error("Multiple pending asks; specify to or replyTo");
  return fromPeer[0]!;
}

/** Blocking ask. The reply (or timeout) is the tool result. */
export function askBotIntercom(input: AskBotIntercomInput): Promise<BotIntercomMessageV1> {
  const prepared = prepareDelivery(input, "ask");
  if (waitingBots.has(prepared.fromBotId)) {
    throw new Error("Already waiting for a reply");
  }
  const reversePending = [...pendingAsks.values()].some(
    (record) => record.fromBotId === prepared.toBotId && record.toBotId === prepared.fromBotId,
  );
  if (reversePending) {
    throw new Error("Mutual ask refused until the original ask is answered");
  }
  if (input.signal?.aborted) {
    throw new Error("Cancelled");
  }
  waitingBots.add(prepared.fromBotId);

  const askRoundTrips = prepared.hop.thread.askRoundTrips + 1;
  let message: BotIntercomMessageV1;
  try {
    message = commitOutgoing("ask", prepared);
  } catch (error) {
    waitingBots.delete(prepared.fromBotId);
    throw error;
  }
  const record: PendingAskRecord = {
    id: message.id,
    conversationId: prepared.hop.thread.id,
    fromBotId: prepared.fromBotId,
    toBotId: prepared.toBotId,
    text: prepared.text,
    createdAt: message.createdAt,
    expiresAt: message.createdAt + askTimeoutMs,
    depth: prepared.hop.depth,
  };
  try {
    rememberThread(prepared.hop.thread, prepared.fromBotId, prepared.toBotId, prepared.hop.depth, askRoundTrips);
    deliverToMailboxes(message);
    attachPendingAsk(record);
  } catch (error) {
    waitingBots.delete(prepared.fromBotId);
    throw error;
  }

  return new Promise<BotIntercomMessageV1>((resolve, reject) => {
    const timer = setTimeout(() => {
      detachPendingAsk(record.id);
      rejectWaiter(record.id, askTimeoutError(record));
    }, askTimeoutMs);
    const onAbort = () => {
      detachPendingAsk(record.id);
      rejectWaiter(record.id, new Error("Cancelled"));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    waiters.set(record.id, {
      fromBotId: prepared.fromBotId,
      resolve: (reply) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        waiters.delete(record.id);
        waitingBots.delete(prepared.fromBotId);
        resolve(reply);
      },
      reject: (error) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        waiters.delete(record.id);
        waitingBots.delete(prepared.fromBotId);
        reject(error);
      },
      timer,
      abort: () => input.signal?.removeEventListener("abort", onAbort),
    });
    waitingBots.add(prepared.fromBotId);
  });
}

/** Reply to one inbound ask. Completes the waiter at most once (no double-delivery). */
export function replyBotIntercom(input: ReplyBotIntercomInput): BotIntercomMessageV1 {
  assertDmAllowed(input.roomTurn);
  const text = input.text.trim();
  const attachments = input.attachments && input.attachments.length > 0 ? input.attachments : undefined;
  if (!text && !attachments) throw new Error("Message text is required");
  if (text.length > BOT_INTERCOM_MESSAGE_MAX) throw new Error("Message text is too long");

  const fromBotId = input.fromBotId.trim();
  if (!getBot(fromBotId)) throw new Error("Sender Bot is not available");
  assertSendConsent(fromBotId, "sender");

  const pending = resolveAskTarget(fromBotId, input.to, input.replyTo);
  if (pending.toBotId !== fromBotId) throw new Error("No pending ask");
  const toBotId = pending.fromBotId;
  if (toBotId === fromBotId) throw new Error("Cannot send intercom to the current Bot");
  assertSendConsent(toBotId, "recipient");

  const hop = nextThreadHop(fromBotId, toBotId);
  // Reply completes the ask. It reverses the pair so the next ask counts as a hop,
  // but does not increment depth (otherwise the finishing reply could hang the waiter).
  const depth = hop.thread.depth;
  const delivery = deliveryFor(toBotId);
  const id = randomUUID();
  const stored = storeAttachments(id, attachments);
  const message = buildMessage("reply", fromBotId, toBotId, text, depth, pending.conversationId, {
    id,
    replyTo: pending.id,
    queued: delivery === "queued",
    delivery,
    attachments: stored,
    scopeId: botIntercomScopeId(getBot(fromBotId)),
  });
  rememberThread(hop.thread, fromBotId, toBotId, depth, hop.thread.askRoundTrips);
  detachPendingAsk(pending.id);
  deliverToMailboxes(message);

  const waiter = waiters.get(pending.id);
  if (waiter) {
    waiter.resolve(message);
  }
  return message;
}

/** Cancel an outbound message. Same sender only; both mailboxes see cancelled. */
export function cancelBotIntercom(input: CancelBotIntercomInput): BotIntercomMessageV1 {
  assertDmAllowed(input.roomTurn);
  const fromBotId = input.fromBotId.trim();
  if (!getBot(fromBotId)) throw new Error("Sender Bot is not available");
  assertSendConsent(fromBotId, "sender");

  const messageId = input.messageId.trim();
  if (!messageId) throw new Error("Unknown message");
  const owned = findOwnedMessage(fromBotId, messageId);
  if (!owned) {
    const existing = inboxState(fromBotId).messages.find((message) => message.id === messageId);
    if (existing) throw new Error("Only the sender can cancel");
    throw new Error("Unknown message");
  }
  if (owned.cancelled || owned.supersededBy) {
    throw new Error("Message already cancelled or superseded");
  }

  patchMessageCopies(owned.id, (message) => {
    message.cancelled = true;
    message.delivery = "cancelled";
  }, [owned.fromBotId, owned.toBotId]);
  if (pendingAsks.has(owned.id)) {
    detachPendingAsk(owned.id);
    rejectWaiter(owned.id, new Error(`Cancelled (messageId: ${owned.id})`));
  }
  const updated = findOwnedMessage(fromBotId, owned.id);
  if (!updated) throw new Error("Unknown message");
  return updated;
}

export function botIntercomMailboxPathForTests(botId: string): string {
  return mailboxPath(botId);
}

export function botIntercomAttachmentsDirForTests(): string {
  return attachmentsDir();
}
