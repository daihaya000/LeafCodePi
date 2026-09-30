import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeRoom } from "./room-normalize.mjs";

export const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
/** Live rooms stay a bounded file; older turns move to append-only history. */
export const MAX_LIVE_ROOM_MESSAGES = 500;
/** Image MIME types the room stores, and the extension used on disk (order matters for lookups). */
export const ROOM_IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
/** Attachment names are server-generated; anything else must not reach the filesystem. */
const ROOM_IMAGE_FILE_PATTERN = /^[0-9a-f-]{36}-\d{1,2}\.(png|jpg|webp|gif)$/i;
const ROOM_FILE_PATTERN = /^[0-9a-f-]{36}-\d{1,2}\.dat$/i;

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

  /** Per-room data directory (images, attachments, relay state, archived history). */
  roomDataRoot(id) {
    return join(this.roomsRoot(), id);
  }

  roomImagePath(roomId, file) {
    this.assertId(roomId);
    if (!ROOM_IMAGE_FILE_PATTERN.test(file)) throw new Error("invalid room image");
    return join(this.roomDataRoot(roomId), "images", file);
  }

  roomFilePath(roomId, file) {
    this.assertId(roomId);
    if (!ROOM_FILE_PATTERN.test(file)) throw new Error("invalid room file");
    return join(this.roomDataRoot(roomId), "files", file);
  }

  /** Undefined when the name has no known image extension, or the file is missing or unreadable. */
  readRoomImage(roomId, file) {
    try {
      const mimeType = Object.entries(ROOM_IMAGE_EXTENSIONS).find(([, extension]) => file.toLowerCase().endsWith(`.${extension}`))?.[0];
      return mimeType ? { bytes: readFileSync(this.roomImagePath(roomId, file)), mimeType } : undefined;
    } catch { return undefined; }
  }

  readRoomFile(roomId, file) {
    try { return { bytes: readFileSync(this.roomFilePath(roomId, file)) }; } catch { return undefined; }
  }

  /** Relay envelope/claim state for one room, kept beside its history and attachments. */
  relayStatePath(roomId) {
    this.assertId(roomId);
    return join(this.roomDataRoot(roomId), "relay.json");
  }

  /** A missing, unreadable or malformed file is an empty state, never a thrown error. */
  readRelayState(roomId) {
    try {
      const value = JSON.parse(readFileSync(this.relayStatePath(roomId), "utf8"));
      const envelopes = value.envelopes && typeof value.envelopes === "object" ? value.envelopes : {};
      const claims = value.claims && typeof value.claims === "object" ? value.claims : {};
      return { envelopes, claims };
    } catch { return { envelopes: {}, claims: {} }; }
  }

  /**
   * Replace the relay state atomically: rename is atomic on the room's local
   * filesystem, so a restart never sees a half-written claim or envelope file.
   * As before, a failed write leaves its temporary file behind.
   */
  writeRelayState(roomId, state) {
    mkdirSync(this.roomDataRoot(roomId), { recursive: true });
    const path = this.relayStatePath(roomId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  }

  /**
   * Live rooms stay a bounded file; older turns move to the append-only history.
   * Removes the overflow from room.messages in place so the caller can write the
   * trimmed room, and returns how many messages were archived.
   */
  archiveOverflow(room, maxLiveMessages = MAX_LIVE_ROOM_MESSAGES) {
    if (room.messages.length <= maxLiveMessages) return 0;
    const overflow = room.messages.splice(0, room.messages.length - maxLiveMessages);
    const dataRoot = this.roomDataRoot(room.id);
    mkdirSync(dataRoot, { recursive: true });
    appendFileSync(join(dataRoot, "history.jsonl"), `${overflow.map((message) => JSON.stringify(message)).join("\n")}\n`, "utf8");
    return overflow.length;
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
