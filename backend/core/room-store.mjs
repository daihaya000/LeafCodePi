import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeRoom } from "./room-normalize.mjs";

export const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

export function isValidRoomId(id) {
  return ROOM_ID_PATTERN.test(id);
}

/**
 * Room file persistence: one validated JSON file per room plus a `<id>/` data
 * directory next to it. The root is resolved per call (it follows the data
 * directory), and change notification is an injected hook so the store itself
 * owns no process-local state.
 */
export class RoomFileStore {
  constructor({ roomsRoot, handoffStates, onWritten = () => undefined }) {
    this.roomsRoot = roomsRoot;
    this.handoffStates = handoffStates;
    this.onWritten = onWritten;
  }

  assertId(id) {
    if (!isValidRoomId(id)) throw new Error("invalid room id");
  }

  roomPath(id) {
    this.assertId(id);
    return join(this.roomsRoot(), `${id}.json`);
  }

  /** Undefined for a missing, unreadable, malformed or invalid-id room. */
  readRoom(id) {
    try {
      return normalizeRoom(JSON.parse(readFileSync(this.roomPath(id), "utf8")), id, this.handoffStates) ?? undefined;
    } catch { return undefined; }
  }

  /**
   * Replace the room file atomically (temp file + rename, so a crash never leaves
   * a truncated room), then notify. A failed write throws and notifies nobody.
   */
  writeRoom(room) {
    mkdirSync(this.roomsRoot(), { recursive: true });
    const path = this.roomPath(room.id);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(room, null, 2)}\n`, "utf8");
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.onWritten(room);
  }

  /** Every valid room, most recently updated first. Files that fail validation are skipped. */
  listRooms() {
    const root = this.roomsRoot();
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.readRoom(entry.name.slice(0, -5)))
      .filter((room) => Boolean(room))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
