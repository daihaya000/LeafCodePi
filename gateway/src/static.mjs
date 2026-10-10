import { lstat, open, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
}));
const screen = /^\/(?:settings|login|bots(?:\/[^/.]+|\/rooms\/[^/.]+)?|task\/[^/.]+)?$/;
const reserved = path => path === "/api" || path.startsWith("/api/") || path === "/webui-bootstrap.json" || path.startsWith("/_next/");
const failure = (status, error) => Response.json({ error }, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/** Decode once, before WHATWG path normalization can hide traversal or Windows separators. */
export function staticTargetPath(target) {
  const raw = target.split("?", 1)[0];
  if (!raw.startsWith("/") || /[\\#]|%2f|%5c/i.test(raw)) return null;
  let path;
  try { path = decodeURIComponent(raw); } catch { return null; }
  if (/[\x00-\x1f\x7f\\:%?#]/.test(path)) return null;
  const segments = path.split("/").slice(1);
  if (segments.some((part, index) => (!part && index !== segments.length - 1) || part.startsWith(".") || /[. ]$/.test(part))) return null;
  return path;
}

/** Pin a finite immutable build in memory. Requests never read paths supplied by clients. */
export async function createStaticHandler(directory, { maxBytes = 128 * 1024 * 1024, maxFiles = 4096 } = {}) {
  if (typeof directory !== "string" || !directory.trim() || !isAbsolute(directory)) throw new Error("SPA build directory must be explicit and absolute");
  const configured = resolve(directory);
  const info = await lstat(configured).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("SPA build directory unavailable or linked");
  const root = await realpath(configured), files = new Map();
  let bytes = 0;
  async function collect(folder) {
    for (const entry of await readdir(folder)) {
      if (entry.startsWith(".")) throw new Error("Hidden file in SPA build");
      const path = join(folder, entry), before = await lstat(path);
      if (before.isSymbolicLink()) throw new Error("Linked file in SPA build");
      const canonical = await realpath(path), rel = relative(root, canonical);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("SPA build path escaped");
      if (before.isDirectory()) { await collect(path); continue; }
      const name = relative(root, path).replaceAll("\\", "/"), url = "/" + name, type = TYPES.get(extname(name).toLowerCase());
      if (!before.isFile() || !type || staticTargetPath(url) !== url || reserved(url) || name !== "index.html" && type.startsWith("text/html")) throw new Error("Unexpected file in SPA build");
      if (files.size >= maxFiles || (bytes += before.size) > maxBytes) throw new Error("SPA build exceeds snapshot limit");
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let content;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("SPA build file changed during open");
        content = await handle.readFile();
        const after = await handle.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || content.length !== before.size) throw new Error("SPA build changed during snapshot");
      } finally { await handle.close(); }
      const etag = `W/"${createHash("sha256").update(content).digest("hex")}"`;
      // Vite's default content-hashed asset names only; public/unhashed files must revalidate.
      const immutable = /^assets\/(?:[^/]+\/)*[^/]+-[\w-]{8}\.[a-z0-9]+$/i.test(name);
      files.set(url, { content, type, etag, cache: name === "index.html" ? "no-store" : immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate" });
    }
  }
  await collect(root);
  const index = files.get("/index.html");
  if (!index || !/<html[\s>]/i.test(index.content.toString("utf8"))) throw new Error("SPA build requires a nonempty index.html");
  const html = index.content.toString("utf8");
  // Missing emitted script/style references are a broken build, not SPA fallback candidates.
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["'](\/assets\/[^"']+)["']/g)) {
    if (!files.has(match[1])) throw new Error("SPA entry references a missing asset");
  }
  if (![...html.matchAll(/<script\b[^>]*>/gi)].some(([tag]) => /\btype\s*=\s*["']module["']/i.test(tag) && /\bsrc\s*=\s*["']\/assets\/[^"']+\.js["']/i.test(tag))) throw new Error("SPA build requires a module entry asset");
  return {
    isPublicAsset(path) {
      const decoded = staticTargetPath(path);
      // Missing resources must be 404, never a redirect to a Login HTML document.
      return !!decoded && decoded !== "/index.html" && (files.has(decoded) || decoded.startsWith("/assets/") || TYPES.has(extname(decoded).toLowerCase()) && extname(decoded).toLowerCase() !== ".html");
    },
    validateTarget(target) { return staticTargetPath(target) !== null; },
    handle(request) {
      if (!["GET", "HEAD"].includes(request.method)) { const response = failure(405, "Method Not Allowed"); response.headers.set("allow", "GET, HEAD"); return response; }
      const path = staticTargetPath(new URL(request.url).pathname);
      if (path === null) return failure(400, "Bad Request");
      if (reserved(path)) return failure(404, "Not Found");
      const file = files.get(path) ?? (screen.test(path) ? index : undefined);
      if (!file) return failure(404, "Not Found");
      const headers = { "content-type": file.type, "cache-control": file.cache, "x-content-type-options": "nosniff" };
      if (file !== index) {
        headers.etag = file.etag;
        if (request.headers.get("if-none-match")?.split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === file.etag.slice(2))) return new Response(null, { status: 304, headers });
      }
      headers["content-length"] = String(file.content.length);
      return new Response(request.method === "HEAD" ? null : file.content, { headers });
    },
  };
}
