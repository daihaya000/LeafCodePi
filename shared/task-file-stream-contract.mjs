export const TASK_FILE_STREAM_PATH = "/internal/file-stream";
export const TASK_FILE_ROUTES = Object.freeze({ "tasks/[id]/media": ["GET", "HEAD"], "tasks/[id]/image": ["GET", "HEAD"] });
export const FILE_STREAM_HEADERS = Object.freeze(["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "cache-control", "cross-origin-resource-policy", "x-content-type-options"]);
export function taskFileTarget(route) {
  const match = /^tasks\/([^/]+)\/(media|image)$/.exec(route);
  if (!match) return null;
  let id; try { id = decodeURIComponent(match[1]); } catch { return null; }
  if (!id || id.length > 512 || /[\/\\\u0000-\u001f\u007f]/.test(id) || id.includes("..")) return null;
  return { route: `tasks/[id]/${match[2]}`, id, kind: match[2] };
}
