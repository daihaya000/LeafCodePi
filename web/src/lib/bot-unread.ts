export type BotUnreadKind = "bot" | "room";

const LAST_READ_PREFIX = "webui.bot.last_read";
const lastMarkedAtCache = new WeakMap<object, Map<string, number>>();

function lastReadKey(kind: BotUnreadKind, id: string): string {
  return `${LAST_READ_PREFIX}.${kind}.${id}`;
}

export function getLastReadAt(kind: BotUnreadKind, id: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const value = Number(window.localStorage.getItem(lastReadKey(kind, id)));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    // プライベートモード等でストレージが使えない場合は未読扱いにしない。
    return null;
  }
}

export function markRead(kind: BotUnreadKind, id: string, messageAt: number): void {
  if (typeof window === "undefined" || !Number.isFinite(messageAt) || messageAt <= 0) return;
  const key = lastReadKey(kind, id);
  let cache = lastMarkedAtCache.get(window);
  if (!cache) {
    cache = new Map();
    lastMarkedAtCache.set(window, cache);
  }
  const cached = cache.get(key);
  if (cached !== undefined && cached >= messageAt) return;
  const previous = getLastReadAt(kind, id);
  if (previous !== null && previous >= messageAt) {
    cache.set(key, previous);
    return;
  }
  try {
    window.localStorage.setItem(key, String(messageAt));
    cache.set(key, messageAt);
  } catch {
    /* プライベートモード等では永続できないだけ */
  }
}

export function hasUnread(lastMessageAt: string | null, lastReadAt: number | null): boolean {
  if (!lastMessageAt) return false;
  const messageAt = Date.parse(lastMessageAt);
  return Number.isFinite(messageAt) && (lastReadAt === null || messageAt > lastReadAt);
}
