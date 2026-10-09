import { publicSidebarRoom } from "./bot-overview-contract.mjs";
import { publicTaskOperation } from "./task-collection-contract.mjs";
export const ROOM_LIFECYCLE_ROUTES = Object.freeze({ "bots/rooms": ["GET", "POST"], "bots/rooms/[id]": ["GET", "PATCH", "DELETE"] });
export function roomLifecycleTarget(path) {
  if (Object.hasOwn(ROOM_LIFECYCLE_ROUTES, path)) return { route: path, params: {} };
  const match = /^bots\/rooms\/([^/]+)$/.exec(path);
  if (!match) return null;
  try { return { route: "bots/rooms/[id]", params: { id: decodeURIComponent(match[1]) } }; } catch { return null; }
}
export function roomLifecycleBodyLimit(_path, method) { return method === "DELETE" ? 4096 : 65536; }
/** The same full, deeply projected Room vocabulary as the sidebar, without derived preview fields. */
export function publicRoom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = publicSidebarRoom({ ...value, lastMessageSummary: null, lastMessageAt: null });
  if (!out) return null;
  delete out.lastMessageSummary; delete out.lastMessageAt;
  return out;
}
export function publicRoomLifecycleBody(route, value, status, method) {
  if (!Object.hasOwn(ROOM_LIFECYCLE_ROUTES, route) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) {
    if (out.error !== undefined) return null;
    if (method === "DELETE") { if (value.ok !== true) return null; out.ok = true; }
    else if (route === "bots/rooms" && method === "GET") {
      if (!Array.isArray(value.rooms)) return null;
      out.rooms = value.rooms.map(publicRoom); if (out.rooms.some(room => !room)) return null;
    } else { out.room = publicRoom(value.room); if (!out.room) return null; }
  }
  if (value.operation !== undefined && method !== "GET") { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
  return out;
}
