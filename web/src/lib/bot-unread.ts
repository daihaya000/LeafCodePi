export type BotUnreadKind = "bot" | "room";

const LAST_READ_PREFIX = "webui.bot.last_read";

function lastReadKey(kind: BotUnreadKind, id: string): string {
  return `${LAST_READ_PREFIX}.${kind}.${id}`;
}

export function getLastReadAt(kind: BotUnreadKind, id: string): number | null {
  if (typeof window === "undefined") return null;
  const value = Number(window.localStorage.getItem(lastReadKey(kind, id)));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function markRead(kind: BotUnreadKind, id: string, messageAt: number): void {
  if (typeof window === "undefined" || !Number.isFinite(messageAt) || messageAt <= 0) return;
  const previous = getLastReadAt(kind, id);
  if (previous !== null && previous >= messageAt) return;
  window.localStorage.setItem(lastReadKey(kind, id), String(messageAt));
}

export function hasUnread(lastMessageAt: string | null, lastReadAt: number | null): boolean {
  if (!lastMessageAt) return false;
  const messageAt = Date.parse(lastMessageAt);
  return Number.isFinite(messageAt) && (lastReadAt === null || messageAt > lastReadAt);
}
