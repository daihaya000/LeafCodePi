import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBot, listBots } from "@/lib/bots";
import { dataDir } from "@/lib/paths";
import { MAX_ROOM_RELAY_DEPTH } from "@/lib/rooms";
import {
  BOT_INTERCOM_SCHEMA_VERSION,
  type BotIntercomInboxDto,
  type BotIntercomInboxItemDto,
  type BotIntercomMessageKind,
  type BotIntercomMessageV1,
  type BotIntercomPendingAskDto,
} from "@/lib/types";

export { BOT_INTERCOM_SCHEMA_VERSION };
export type { BotIntercomInboxDto, BotIntercomInboxItemDto, BotIntercomMessageV1, BotIntercomPendingAskDto };

/** Same hop budget as Room relay (`MAX_ROOM_RELAY_DEPTH`). */
export const MAX_BOT_INTERCOM_DEPTH = MAX_ROOM_RELAY_DEPTH;
/** Same-thread ask/reply round-trips share the Room hop budget. */
export const MAX_BOT_INTERCOM_ASK_ROUNDTRIPS = MAX_BOT_INTERCOM_DEPTH;

export const BOT_INTERCOM_MESSAGE_MAX = 2_000;
export const BOT_INTERCOM_MAILBOX_MAX = 256;
export const BOT_INTERCOM_ASK_TIMEOUT_MS = 10 * 60 * 1000;

export type BotIntercomPeerDto = {
  id: string;
  name: string;
  resident: boolean;
  intercomEnabled: boolean;
};

export type SendBotIntercomInput = {
  /** Server-derived sender. Callers must never take this from tool arguments. */
  fromBotId: string;
  to: string;
  text: string;
  /** Room turns keep formal @ on room_handoff; the DM path must not run. */
  roomTurn?: boolean;
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
let askTimeoutMs = BOT_INTERCOM_ASK_TIMEOUT_MS;

const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

/** Harness installs this so "resident" means a live 1:1 session (`bot:<id>`). */
export function setBotIntercomResidentLookup(lookup: (botId: string) => boolean): void {
  residentLookup = lookup;
}

export function isBotIntercomResident(botId: string): boolean {
  return residentLookup(botId);
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

function atomicWrite(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  renameSync(temporary, file);
}

function asMessage(value: unknown): BotIntercomMessageV1 | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<BotIntercomMessageV1>;
  if (row.v !== BOT_INTERCOM_SCHEMA_VERSION) return null;
  if (typeof row.id !== "string" || typeof row.fromBotId !== "string" || typeof row.toBotId !== "string") return null;
  if (typeof row.text !== "string" || typeof row.createdAt !== "number" || typeof row.depth !== "number") return null;
  const kind = row.kind === "ask" || row.kind === "reply" || row.kind === "send" ? row.kind : undefined;
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
}

export function getBotIntercomInbox(botId: string): BotIntercomInboxDto {
  pruneExpiredAsks(botId);
  const state = inboxState(botId);
  const messages = state.messages.map(toInboxItem);
  const unreadCount = messages.filter((message) => message.toBotId === botId && message.createdAt > state.lastReadAt).length;
  const latest = [...messages].reverse().find((message) => message.toBotId === botId) ?? messages[messages.length - 1];
  return {
    messages,
    unreadCount,
    preview: latest
      ? {
          fromBotId: latest.fromBotId,
          fromName: latest.fromName,
          text: previewText(latest.text),
          createdAt: latest.createdAt,
          ...(latest.kind ? { kind: latest.kind } : {}),
        }
      : null,
    pendingAsks: state.pendingAsks.map(toPendingDto),
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

export function listBotIntercomPeers(fromBotId: string): BotIntercomPeerDto[] {
  return listBots()
    .filter((bot) => bot.id !== fromBotId && bot.enabled)
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      resident: isBotIntercomResident(bot.id),
      intercomEnabled: bot.intercomEnabled === true,
    }));
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

function prepareDelivery(input: SendBotIntercomInput, kind: BotIntercomMessageKind): {
  fromBotId: string;
  toBotId: string;
  text: string;
  hop: { thread: PairThread; depth: number };
  queued: boolean;
} {
  assertDmAllowed(input.roomTurn);
  const text = input.text.trim();
  if (!text) throw new Error("Message text is required");
  if (text.length > BOT_INTERCOM_MESSAGE_MAX) throw new Error("Message text is too long");

  const fromBotId = input.fromBotId.trim();
  if (!getBot(fromBotId)) throw new Error("Sender Bot is not available");
  const toBotId = resolveDestinationBotId(input.to);
  if (toBotId === fromBotId) throw new Error("Cannot send intercom to the current Bot");

  assertSendConsent(fromBotId, "sender");
  assertSendConsent(toBotId, "recipient");

  const hop = nextThreadHop(fromBotId, toBotId);
  if (hop.depth > MAX_BOT_INTERCOM_DEPTH) {
    throw new Error("Intercom rejected: maximum depth exceeded");
  }
  if (kind === "ask" && hop.thread.askRoundTrips >= MAX_BOT_INTERCOM_ASK_ROUNDTRIPS) {
    throw new Error("Intercom rejected: maximum ask/reply depth exceeded");
  }

  return {
    fromBotId,
    toBotId,
    text,
    hop,
    queued: !isBotIntercomResident(toBotId),
  };
}

function buildMessage(
  kind: BotIntercomMessageKind,
  fromBotId: string,
  toBotId: string,
  text: string,
  depth: number,
  conversationId: string,
  extras: { replyTo?: string; queued?: boolean } = {},
): BotIntercomMessageV1 {
  return {
    v: BOT_INTERCOM_SCHEMA_VERSION,
    id: randomUUID(),
    fromBotId,
    toBotId,
    text,
    createdAt: Date.now(),
    depth,
    kind,
    conversationId,
    ...(extras.replyTo ? { replyTo: extras.replyTo } : {}),
    ...(extras.queued ? { queued: true } : {}),
  };
}

/** Deliver a `send`. Sender identity is only the provided fromBotId. Offline bots are queued. */
export function sendBotIntercom(input: SendBotIntercomInput): BotIntercomMessageV1 {
  const prepared = prepareDelivery(input, "send");
  const message = buildMessage(
    "send",
    prepared.fromBotId,
    prepared.toBotId,
    prepared.text,
    prepared.hop.depth,
    prepared.hop.thread.id,
    { queued: prepared.queued },
  );
  rememberThread(prepared.hop.thread, prepared.fromBotId, prepared.toBotId, prepared.hop.depth);
  deliverToMailboxes(message);
  return message;
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
  const message = buildMessage(
    "ask",
    prepared.fromBotId,
    prepared.toBotId,
    prepared.text,
    prepared.hop.depth,
    prepared.hop.thread.id,
    { queued: prepared.queued },
  );
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
  if (!text) throw new Error("Message text is required");
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
  const message = buildMessage("reply", fromBotId, toBotId, text, depth, pending.conversationId, {
    replyTo: pending.id,
    queued: !isBotIntercomResident(toBotId),
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

export function botIntercomMailboxPathForTests(botId: string): string {
  return mailboxPath(botId);
}
