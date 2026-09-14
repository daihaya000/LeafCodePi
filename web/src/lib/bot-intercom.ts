import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { getBot, listBots } from "@/lib/bots";
import { MAX_ROOM_RELAY_DEPTH } from "@/lib/rooms";
import {
  BOT_INTERCOM_SCHEMA_VERSION,
  type BotIntercomInboxDto,
  type BotIntercomInboxItemDto,
  type BotIntercomMessageV1,
} from "@/lib/types";

export { BOT_INTERCOM_SCHEMA_VERSION };
export type { BotIntercomInboxDto, BotIntercomInboxItemDto, BotIntercomMessageV1 };

/** Same hop budget as Room relay (`MAX_ROOM_RELAY_DEPTH`). */
export const MAX_BOT_INTERCOM_DEPTH = MAX_ROOM_RELAY_DEPTH;

export const BOT_INTERCOM_MESSAGE_MAX = 2_000;

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

type PairThread = {
  id: string;
  lastFrom: string;
  lastTo: string;
  depth: number;
};

type InboxState = {
  messages: BotIntercomMessageV1[];
  lastReadAt: number;
};

const inboxEvents = new EventEmitter();
inboxEvents.setMaxListeners(0);

const inboxes = new Map<string, InboxState>();
const threads = new Map<string, PairThread>();

let residentLookup: (botId: string) => boolean = () => false;

/** Harness installs this so "resident" means a live 1:1 session (`bot:<id>`). */
export function setBotIntercomResidentLookup(lookup: (botId: string) => boolean): void {
  residentLookup = lookup;
}

export function isBotIntercomResident(botId: string): boolean {
  return residentLookup(botId);
}

export function subscribeBotIntercomInbox(botId: string, listener: (inbox: BotIntercomInboxDto) => void): () => void {
  const handler = (inbox: BotIntercomInboxDto) => listener(inbox);
  inboxEvents.on(botId, handler);
  return () => {
    inboxEvents.off(botId, handler);
  };
}

export function resetBotIntercomForTests(): void {
  inboxes.clear();
  threads.clear();
  inboxEvents.removeAllListeners();
  residentLookup = () => false;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function inboxState(botId: string): InboxState {
  const existing = inboxes.get(botId);
  if (existing) return existing;
  const created = { messages: [], lastReadAt: 0 };
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
    v: BOT_INTERCOM_SCHEMA_VERSION,
    id: message.id,
    fromBotId: message.fromBotId,
    fromName: getBot(message.fromBotId)?.name ?? "不明なBot",
    toBotId: message.toBotId,
    text: message.text,
    createdAt: message.createdAt,
    depth: message.depth,
  };
}

export function getBotIntercomInbox(botId: string): BotIntercomInboxDto {
  const state = inboxState(botId);
  const messages = state.messages.map(toInboxItem);
  const unreadCount = messages.filter((message) => message.createdAt > state.lastReadAt).length;
  const latest = messages[messages.length - 1];
  return {
    messages,
    unreadCount,
    preview: latest
      ? {
          fromBotId: latest.fromBotId,
          fromName: latest.fromName,
          text: previewText(latest.text),
          createdAt: latest.createdAt,
        }
      : null,
  };
}

export function markBotIntercomInboxRead(botId: string, readAt = Date.now()): BotIntercomInboxDto {
  const state = inboxState(botId);
  const latest = state.messages[state.messages.length - 1]?.createdAt ?? readAt;
  state.lastReadAt = Math.max(state.lastReadAt, readAt, latest);
  const inbox = getBotIntercomInbox(botId);
  inboxEvents.emit(botId, inbox);
  return inbox;
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

function nextThreadHop(fromBotId: string, toBotId: string): { threadId: string; depth: number } {
  const key = pairKey(fromBotId, toBotId);
  const current = threads.get(key);
  if (!current) return { threadId: randomUUID(), depth: 0 };
  if (current.lastTo === fromBotId && current.lastFrom === toBotId) {
    return { threadId: current.id, depth: current.depth + 1 };
  }
  if (current.lastFrom === fromBotId && current.lastTo === toBotId) {
    return { threadId: current.id, depth: current.depth };
  }
  return { threadId: randomUUID(), depth: 0 };
}

function rememberThread(threadId: string, fromBotId: string, toBotId: string, depth: number): void {
  threads.set(pairKey(fromBotId, toBotId), {
    id: threadId,
    lastFrom: fromBotId,
    lastTo: toBotId,
    depth,
  });
}

/** Deliver a Phase A `send`. Sender identity is only the provided fromBotId. */
export function sendBotIntercom(input: SendBotIntercomInput): BotIntercomMessageV1 {
  if (input.roomTurn) {
    throw new Error("Intercom DM is not available during a Room turn; formal @ stays on room_handoff");
  }
  const text = input.text.trim();
  if (!text) throw new Error("Message text is required");
  if (text.length > BOT_INTERCOM_MESSAGE_MAX) throw new Error("Message text is too long");

  const fromBotId = input.fromBotId.trim();
  if (!getBot(fromBotId)) throw new Error("Sender Bot is not available");
  const toBotId = resolveDestinationBotId(input.to);
  if (toBotId === fromBotId) throw new Error("Cannot send intercom to the current Bot");

  assertSendConsent(fromBotId, "sender");
  assertSendConsent(toBotId, "recipient");

  if (!isBotIntercomResident(toBotId)) {
    throw new Error("Recipient Bot is not resident (no live 1:1 session)");
  }

  const hop = nextThreadHop(fromBotId, toBotId);
  if (hop.depth > MAX_BOT_INTERCOM_DEPTH) {
    throw new Error("Intercom rejected: maximum depth exceeded");
  }

  const message: BotIntercomMessageV1 = {
    v: BOT_INTERCOM_SCHEMA_VERSION,
    id: randomUUID(),
    fromBotId,
    toBotId,
    text,
    createdAt: Date.now(),
    depth: hop.depth,
  };
  rememberThread(hop.threadId, fromBotId, toBotId, hop.depth);
  inboxState(toBotId).messages.push(message);
  inboxEvents.emit(toBotId, getBotIntercomInbox(toBotId));
  return message;
}
