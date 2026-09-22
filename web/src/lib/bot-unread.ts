import { getJson, sendJson } from "@/lib/client";

export type BotUnreadKind = "bot" | "room" | "task";
type UnreadMarker = { kind: BotUnreadKind; id: string; readAt: number };

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

function merge(marker: UnreadMarker): boolean {
  if (!Number.isFinite(marker.readAt) || marker.readAt <= 0) return false;
  const key = markerKey(marker.kind, marker.id);
  const previous = lastRead.get(key) ?? 0;
  if (previous >= marker.readAt) return false;
  lastRead.set(key, marker.readAt);
  return true;
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
      if (!Array.isArray(data.markers)) return;
      const changed = data.markers.reduce((result, marker) => {
        if (!marker || typeof marker !== "object") return result;
        const value = marker as Partial<UnreadMarker>;
        if ((value.kind !== "bot" && value.kind !== "room" && value.kind !== "task") || typeof value.id !== "string") return result;
        return merge({ kind: value.kind, id: value.id, readAt: value.readAt as number }) || result;
      }, false);
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
  if (!merge({ kind, id, readAt: messageAt })) return;
  notify();
  void sendJson<{ readAt?: unknown }>("/api/unread", { kind, id, readAt: messageAt }, "PUT")
    .then((response) => {
      if (typeof response?.readAt === "number" && merge({ kind, id, readAt: response.readAt })) notify();
    })
    .catch(() => undefined);
}

export function hasUnread(lastMessageAt: string | null, lastReadAt: number | null): boolean {
  if (!lastMessageAt) return false;
  const messageAt = Date.parse(lastMessageAt);
  return Number.isFinite(messageAt) && (lastReadAt === null || messageAt > lastReadAt);
}

export function resetUnreadStateForTests(): void {
  stateVersion += 1;
  lastRead.clear();
  snapshot = 0;
  hydrated = false;
  hydratePromise = null;
  listeners.clear();
}
