export const TASK_FILE_STREAM_PATH = "/internal/file-stream";
export const TASK_FILE_ROUTES = Object.freeze({ "tasks/[id]/media": ["GET", "HEAD"], "tasks/[id]/image": ["GET", "HEAD"], "bots/rooms/[id]/files/[file]": ["GET", "HEAD"], "bots/rooms/[id]/images/[file]": ["GET", "HEAD"] });
export const FILE_STREAM_HEADERS = Object.freeze(["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "cache-control", "cross-origin-resource-policy", "x-content-type-options"]);
export function taskFileTarget(route) {
  const room = /^bots\/rooms\/([^/]+)\/(files|images)\/([^/]+)$/.exec(route);
  if (room) {
    let id, file; try { id = decodeURIComponent(room[1]); file = decodeURIComponent(room[3]); } catch { return null; }
    if (id.length > 512 || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id) || file.length > 128) return null;
    if (!(room[2] === "files" ? /^[0-9a-f-]{36}-\d{1,2}\.dat$/i : /^[0-9a-f-]{36}-\d{1,2}\.(png|jpg|webp|gif)$/i).test(file)) return null;
    return { route: `bots/rooms/[id]/${room[2]}/[file]`, id, kind: room[2], file };
  }
  const match = /^tasks\/([^/]+)\/(media|image)$/.exec(route);
  if (!match) return null;
  let id; try { id = decodeURIComponent(match[1]); } catch { return null; }
  if (!id || id.length > 512 || /[\/\\\u0000-\u001f\u007f]/.test(id) || id.includes("..")) return null;
  return { route: `tasks/[id]/${match[2]}`, id, kind: match[2] };
}
