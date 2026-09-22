import { readSettingsFile, updateSettingsFile } from "@/lib/pi/web-settings";

export type UnreadKind = "bot" | "room" | "task";
export type UnreadReadMarker = { kind: UnreadKind; id: string; readAt: number };

const UNREAD_STATE_KEY = "unread-last-read";
const KINDS = new Set<UnreadKind>(["bot", "room", "task"]);
const MAX_ID_LENGTH = 256;

type StoredUnreadState = Partial<Record<UnreadKind, Record<string, number>>>;

function parseStoredState(value: unknown): StoredUnreadState {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state: StoredUnreadState = {};
    for (const kind of KINDS) {
      const entries = (parsed as Record<string, unknown>)[kind];
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      const valid = Object.entries(entries).filter(([id, readAt]) =>
        id.length > 0 && id.length <= MAX_ID_LENGTH && Number.isFinite(readAt) && readAt > 0,
      );
      if (valid.length > 0) state[kind] = Object.fromEntries(valid) as Record<string, number>;
    }
    return state;
  } catch {
    return {};
  }
}

function isValidMarker(kind: unknown, id: unknown, readAt: unknown): boolean {
  return typeof kind === "string" && KINDS.has(kind as UnreadKind)
    && typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH
    && typeof readAt === "number" && Number.isFinite(readAt) && readAt > 0;
}

export function getUnreadReadMarkers(): UnreadReadMarker[] {
  const state = parseStoredState(readSettingsFile()[UNREAD_STATE_KEY]);
  return Object.entries(state).flatMap(([kind, entries]) =>
    Object.entries(entries ?? {}).map(([id, readAt]) => ({ kind: kind as UnreadKind, id, readAt })),
  );
}

export function markUnreadRead(kind: unknown, id: unknown, readAt: unknown): number | null {
  if (!isValidMarker(kind, id, readAt)) return null;
  const markerKind = kind as UnreadKind;
  const markerId = id as string;
  const markerReadAt = readAt as number;
  return updateSettingsFile((settings) => {
    const state = parseStoredState(settings[UNREAD_STATE_KEY]);
    const entries = state[markerKind] ?? {};
    const next = Math.max(entries[markerId] ?? 0, markerReadAt);
    entries[markerId] = next;
    state[markerKind] = entries;
    settings[UNREAD_STATE_KEY] = JSON.stringify(state);
    return next;
  });
}
