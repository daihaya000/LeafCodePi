import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";
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
  assertConfigurationOwner();
  const state = parseStoredState(readSettingsFile()[UNREAD_STATE_KEY]);
  return Object.entries(state).flatMap(([kind, entries]) =>
    Object.entries(entries ?? {}).map(([id, readAt]) => ({ kind: kind as UnreadKind, id, readAt })),
  );
}

export function markUnreadRead(kind: unknown, id: unknown, readAt: unknown): number | null {
  assertConfigurationOwner();
  if (!isValidMarker(kind, id, readAt)) return null;
  const markerKind = kind as UnreadKind;
  const markerId = id as string;
  const markerReadAt = readAt as number;
  return updateSettingsFile((settings) => {
    // The shared settings reader is tolerant for GET; a writer must not replace damaged unrelated settings.
    // Validate under the existing read-modify-write lock, before mutating its cached object.
    try {
      const root = JSON.parse(readFileSync(join(dataDir(), "web-settings.json"), "utf8"));
      if (!root || typeof root !== "object" || Array.isArray(root) || root.version !== 1) throw new Error("Invalid settings");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("既読設定を安全に更新できません");
    }
    const state = parseStoredState(settings[UNREAD_STATE_KEY]);
    const entries: Record<string, number> = Object.assign(Object.create(null), state[markerKind]);
    const next = Math.max(entries[markerId] ?? 0, markerReadAt);
    entries[markerId] = next;
    state[markerKind] = entries;
    settings[UNREAD_STATE_KEY] = JSON.stringify(state);
    return next;
  });
}
