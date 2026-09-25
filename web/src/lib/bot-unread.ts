import { getJson, sendJson } from "@/lib/client";

export type BotUnreadKind = "bot" | "room" | "task";
type UnreadMarker = { kind: BotUnreadKind; id: string; readAt: number };

const LEGACY_LAST_READ_PREFIX = "webui.bot.last_read.";
const lastRead = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot = 0;
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let stateVersion = 0;

function markerKey(kind: BotUnreadKind, id: string): string {
  return `${kind}:${id}`;
}

function notify(): void {
  snapshot += 1;
  for (const listener of listeners) listener();
}

function asMarker(value: unknown): UnreadMarker | null {
  if (!value || typeof value !== "object") return null;
  const marker = value as Partial<UnreadMarker>;
  if ((marker.kind !== "bot" && marker.kind !== "room" && marker.kind !== "task") || typeof marker.id !== "string" || marker.id.length === 0 || marker.id.length > 256 || !Number.isFinite(marker.readAt) || (marker.readAt ?? 0) <= 0) return null;
  return marker as UnreadMarker;
}

function merge(marker: UnreadMarker): boolean {
  const key = markerKey(marker.kind, marker.id);
  const previous = lastRead.get(key) ?? 0;
  if (previous >= marker.readAt) return false;
  lastRead.set(key, marker.readAt);
  return true;
}

function persist(marker: UnreadMarker): void {
  void sendJson<{ readAt?: unknown }>("/api/unread", marker, "PUT")
    .then((response) => {
      if (typeof response?.readAt === "number" && merge({ ...marker, readAt: response.readAt })) notify();
    })
    .catch(() => undefined);
}

function legacyMarkers(): UnreadMarker[] {
  try {
    const markers: UnreadMarker[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(LEGACY_LAST_READ_PREFIX)) continue;
      const [kind, ...idParts] = key.slice(LEGACY_LAST_READ_PREFIX.length).split(".");
      const marker = asMarker({ kind, id: idParts.join("."), readAt: Number(window.localStorage.getItem(key)) });
      if (marker) markers.push(marker);
    }
    return markers;
  } catch {
    return [];
  }
}

export function getUnreadSnapshot(): number {
  return snapshot;
}

export function subscribeUnreadState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** サーバー保存済みの既読位置を読み込み、現在の楽観状態と新しい方を採用する。 */
export function hydrateLastReadState(): Promise<void> {
  if (typeof window === "undefined" || hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  const version = stateVersion;
  hydratePromise = getJson<{ markers?: unknown }>("/api/unread")
    .then((data) => {
      if (version !== stateVersion) return;
      let changed = false;
      for (const value of Array.isArray(data.markers) ? data.markers : []) {
        const marker = asMarker(value);
        changed = Boolean(marker && merge(marker)) || changed;
      }
      for (const marker of legacyMarkers()) {
        if (!merge(marker)) continue;
        changed = true;
        persist(marker);
      }
      hydrated = true;
      if (changed) notify();
    })
    .catch(() => undefined)
    .finally(() => {
      if (version === stateVersion) hydratePromise = null;
    });
  return hydratePromise;
}

export function getLastReadAt(kind: BotUnreadKind, id: string): number | null {
  return lastRead.get(markerKey(kind, id)) ?? null;
}

export function markRead(kind: BotUnreadKind, id: string, messageAt: number): void {
  if (typeof window === "undefined" || !Number.isFinite(messageAt) || messageAt <= 0) return;
  const marker = asMarker({ kind, id, readAt: messageAt });
  if (!marker || !merge(marker)) return;
  notify();
  persist(marker);
}

export function hasUnread(lastMessageAt: string | null, lastReadAt: number | null): boolean {
  if (!lastMessageAt) return false;
  const messageAt = Date.parse(lastMessageAt);
  return Number.isFinite(messageAt) && (lastReadAt === null || messageAt > lastReadAt);
}

type UnreadTaskRef = { id: string; kind?: string | null; status: string; updatedAt: string; projectId?: string | null };
type UnreadChatRef = { id: string; lastMessageAt: string | null };

/** 未読のCodeタスク・Bot・ルームをペインのタブIDとして新しい順に返す。進行中タスクは対象外。 */
export function unreadSessionTabIds({
  tasks = [],
  bots = [],
  rooms = [],
  archivedProjectIds,
  activeTabId = null,
}: {
  tasks?: readonly UnreadTaskRef[];
  bots?: readonly UnreadChatRef[];
  rooms?: readonly UnreadChatRef[];
  archivedProjectIds?: ReadonlySet<string>;
  activeTabId?: string | null;
}): string[] {
  const entries: { tabId: string; at: string }[] = [];
  for (const task of tasks) {
    if (task.kind === "bot" || task.status === "working" || task.status === "archived") continue;
    if (archivedProjectIds?.has(task.projectId ?? "")) continue;
    if (hasUnread(task.updatedAt, getLastReadAt("task", task.id))) entries.push({ tabId: task.id, at: task.updatedAt });
  }
  for (const bot of bots) {
    if (hasUnread(bot.lastMessageAt, getLastReadAt("bot", bot.id))) entries.push({ tabId: `/bots/${encodeURIComponent(bot.id)}`, at: bot.lastMessageAt! });
  }
  for (const room of rooms) {
    if (hasUnread(room.lastMessageAt, getLastReadAt("room", room.id))) entries.push({ tabId: `/bots/rooms/${encodeURIComponent(room.id)}`, at: room.lastMessageAt! });
  }
  return entries
    .filter((entry) => entry.tabId !== activeTabId)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .map((entry) => entry.tabId);
}

export function resetUnreadStateForTests(): void {
  stateVersion += 1;
  lastRead.clear();
  snapshot = 0;
  hydrated = false;
  hydratePromise = null;
  listeners.clear();
}
