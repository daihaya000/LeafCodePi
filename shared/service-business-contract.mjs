import { publicTaskSummary, publicTaskOperation } from "./task-collection-contract.mjs";
/** Public DTOs for stored task views, bounded previews and local translation. No IO here. */
export const SERVICE_BUSINESS_ROUTES = Object.freeze({
  "backend/tasks": ["GET"], "link-preview": ["POST"],
  "link-preview/image": ["GET"], "translation/reasoning": ["POST"],
  "projects/[id]/explorer": ["GET"], "tasks/[id]/explorer": ["GET"],
});
export const PREVIEW_IMAGE_LIMIT = 2 * 1024 * 1024;
export function serviceBusinessTarget(route) {
  if (Object.hasOwn(SERVICE_BUSINESS_ROUTES, route)) return { route, params: {} };
  const match = /^(projects|tasks)\/([^/]+)\/explorer$/.exec(route);
  if (!match) return null;
  let id; try { id = decodeURIComponent(match[2]); } catch { return null; }
  if (!id || id.length > 512 || /[\/\\\u0000-\u001f\u007f]/.test(id) || id.includes("..")) return null;
  return { route: `${match[1]}/[id]/explorer`, params: { id } };
}
export function serviceBusinessBodyLimit(route) { return route === "link-preview" ? 32 * 1024 : 64 * 1024; }
const record = v => v && typeof v === "object" && !Array.isArray(v);
const bounded = (v, n) => typeof v === "string" && v.length <= n;
function previewImage(value) {
  if (!record(value) || !["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(value.contentType)) return null;
  const b = value.base64;
  if (typeof b !== "string" || !b.length || b.length > 4 * Math.ceil(PREVIEW_IMAGE_LIMIT / 3) || b.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b)) return null;
  const padding = b.endsWith("==") ? 2 : b.endsWith("=") ? 1 : 0;
  if (b.length / 4 * 3 - padding > PREVIEW_IMAGE_LIMIT) return null;
  if (padding) {
    const digit = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(b.at(-padding - 1));
    if (digit < 0 || (digit & (padding === 2 ? 15 : 3))) return null;
  }
  return { contentType: value.contentType, base64: b };
}
export function publicServiceBusinessBody(route, value, status) {
  if (!serviceBusinessTarget(route) || !record(value)) return null;
  let out;
  if (status >= 400) {
    if (!bounded(value.error, 400)) return null;
    out = { error: value.error };
  } else if (route === "backend/tasks") {
    if (value.source !== "backend" || !Array.isArray(value.tasks)) return null;
    const tasks = value.tasks.map(publicTaskSummary);
    if (tasks.some(task => !task)) return null;
    out = { source: "backend", tasks };
  } else if (route === "link-preview") {
    if (!bounded(value.url, 8192) || !bounded(value.title, 200) || !/^https?:\/\//i.test(value.url)) return null;
    try { const url = new URL(value.url); if (url.username || url.password || url.port) return null; } catch { return null; }
    out = { url: value.url, title: value.title };
    for (const [key, max] of [["description", 400], ["siteName", 80]]) {
      if (value[key] !== undefined) { if (!bounded(value[key], max)) return null; out[key] = value[key]; }
    }
    if (value.image !== undefined) {
      if (typeof value.image !== "string" || !/^\/api\/link-preview\/image\?id=[a-f0-9]{32}$/.test(value.image)) return null;
      out.image = value.image;
    }
  } else if (route.endsWith("/explorer")) {
    if (!bounded(value.path, 32768) || !value.path.trim() || value.path.includes("\0") || !bounded(value.controlUrl, 2048)) return null;
    try {
      const url = new URL(value.controlUrl);
      if (!["http:", "https:"].includes(url.protocol) || !(["localhost", "[::1]"].includes(url.hostname) || /^127\./.test(url.hostname)) ||
          url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    } catch { return null; }
    out = { path: value.path, controlUrl: value.controlUrl };
  } else if (route === "link-preview/image") {
    const image = previewImage(value.image); if (!image) return null; out = { image };
  } else {
    if (!Array.isArray(value.translations) || value.translations.length < 1 || value.translations.length > 16 ||
        value.translations.some(text => !bounded(text, 64_000)) || value.translations.reduce((n, t) => n + t.length, 0) > 64_000) return null;
    out = { translations: [...value.translations] };
    for (const key of ["fallbacks", "overridden"]) if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length !== value.translations.length || value[key].some(v => typeof v !== "boolean")) return null;
      out[key] = [...value[key]];
    }
  }
  if (route === "translation/reasoning" && value.operation !== undefined) {
    const operation = publicTaskOperation(value.operation);
    if (!operation || (status < 400 && operation.execution !== "complete")) return null;
    out.operation = operation;
  }
  return out;
}
