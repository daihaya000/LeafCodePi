import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { extname } from "node:path";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { taskFileTarget, TASK_FILE_ROUTES } from "@shared/task-file-stream-contract.mjs";
import { openTaskLocalMedia, parseMediaRange } from "../lib/local-media";
import { resolveTaskLocalFile } from "../lib/local-file";
import { imageMimeFromBytes } from "../lib/raster-image";
import { MAX_LOCAL_IMAGE_BYTES } from "../lib/local-image";
import { openRoomAttachment, readRoomAttachmentDiagnostics } from "./room-attachments";
import { openProfileExport, readProfileExportDiagnostics } from "./profile-export";
import { openMessageImage, readMessageImageDiagnostics } from "./message-images";
import { openStoredImage, readLinkPreviewImageDiagnostics, type StoredImage } from "./stored-images";

const CHUNK = 64 * 1024, MAX_ACTIVE = 32;
const counters = { active: 0, descriptors: 0, peakActive: 0, bytesRead: 0 };
export function readTaskFileStreamDiagnostics() { assertConfigurationOwner(); return { ...counters, ...readProfileExportDiagnostics(), ...readMessageImageDiagnostics(), ...readRoomAttachmentDiagnostics(), ...readLinkPreviewImageDiagnostics(), chunkBytes: CHUNK, maxActive: MAX_ACTIVE }; }
type Input = { route: string; method: string; url: string; headers: Record<string, string>; authorized: boolean; signal: AbortSignal };
const mimes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp" };
const fail = (method: string, status: number, error: string) => new Response(method === "HEAD" ? null : JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });

/** Authorization, canonical path resolution and descriptor IO belong exclusively to Backend. */
export async function openTaskFileStream(input: Input): Promise<Response> {
  assertConfigurationOwner();
  const target = taskFileTarget(input.route);
  if (!target) return fail(input.method, 404, "ファイル経路が不正です");
  if (!TASK_FILE_ROUTES[target.route].includes(input.method)) return fail(input.method, 405, "許可されないメソッドです");
  if (process.env.LEAFCODE_PI_WEBUI_AUTH === "required" && !input.authorized) return fail(input.method, 401, "認証が必要です");
  if (input.signal.aborted) return fail(input.method, 400, "接続が中断されました");
  if (counters.active >= MAX_ACTIVE) return fail(input.method, 503, "ファイル配信が混雑しています");
  counters.active++; counters.peakActive = Math.max(counters.peakActive, counters.active);
  let asset: StoredImage | undefined;
  let file: FileHandle | undefined, finished = false, closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    finished = true;
    input.signal.removeEventListener("abort", abort);
    closing = (async () => {
      try { await file?.close(); } catch { /* Peer cancellation must not escape. */ }
      finally { asset?.release(); asset = undefined; if (file) counters.descriptors--; counters.active--; }
    })();
    return closing;
  };
  const abort = () => { void close(); };
  try {
    if (target.kind === "profile-export") {
      const response = await openProfileExport(input, close);
      if (!response.ok || !response.body || response.headers.get("content-type") !== "application/gzip") await close();
      return response;
    }
    const path = new URL(input.url).searchParams.get("path") ?? "";
    let size: number, mime: string, cacheControl = "private, no-store", disposition = "inline";
    if (target.kind === "message-image") {
      const result = await openMessageImage(target.id, input.url, input.signal);
      if (!result.ok) { await close(); return fail(input.method, result.status, result.error); }
      asset = result.image; size = asset.size; mime = asset.mime;
    } else if (target.kind === "project-icon" || target.kind === "preview-image") {
      const result = await openStoredImage(target.kind, target.id, input.url, input.signal);
      if (!result.ok) { await close(); return fail(input.method, result.status, result.error); }
      asset = result.image; size = asset.size; mime = asset.mime; cacheControl = asset.cacheControl;
    } else if (target.kind === "files" || target.kind === "images") {
      const result = await openRoomAttachment(target.id, target.file!, target.kind, input.signal);
      if (!result.ok) { await close(); return fail(input.method, result.status, result.error); }
      file = result.file; size = result.size; mime = result.mime; counters.descriptors++;
      cacheControl = result.cacheControl; disposition = result.disposition;
    } else if (target.kind === "media") {
      const result = await openTaskLocalMedia(target.id, path);
      if (!result.ok) { await close(); return fail(input.method, result.status, result.error); }
      file = result.file; size = result.size; mime = result.mime; counters.descriptors++;
    } else {
      const result = resolveTaskLocalFile(target.id, path);
      if (!result.ok) { await close(); return fail(input.method, result.status, result.error); }
      mime = mimes[extname(path).toLowerCase()];
      if (!mime) { await close(); return fail(input.method, 415, "対応する画像を指定してください"); }
      file = await open(result.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW));
      counters.descriptors++;
      const info = await file.stat(); size = info.size;
      if (!info.isFile() || size <= 0) { await close(); return fail(input.method, 400, "空ではない画像を指定してください"); }
      if (size > MAX_LOCAL_IMAGE_BYTES) { await close(); return fail(input.method, 413, "画像は32 MB以下にしてください"); }
      // Revalidate the canonical name against the opened descriptor before any header bytes are read.
      const canonical = await realpath(result.path), current = await stat(canonical);
      if (canonical !== result.path || current.dev !== info.dev || current.ino !== info.ino) { await close(); return fail(input.method, 403, "ファイルの場所が変更されました"); }
      const header = Buffer.alloc(32), read = await file.read(header, 0, header.length, 0);
      if (imageMimeFromBytes(header.subarray(0, read.bytesRead)) !== mime) { await close(); return fail(input.method, 415, "画像形式を確認できません"); }
    }
    if (input.signal.aborted) { await close(); return fail(input.method, 400, "接続が中断されました"); }
    const stamp = await file?.stat();
    const rangeHeader = input.method === "HEAD" || input.headers["if-range"] !== undefined ? null : input.headers.range ?? null;
    const range = parseMediaRange(rangeHeader, size);
    const headers: Record<string, string> = { "content-type": mime, "content-disposition": disposition, "accept-ranges": "bytes", "cache-control": cacheControl, "cross-origin-resource-policy": "same-origin", "x-content-type-options": "nosniff", ...asset?.headers };
    if (!range) { await close(); return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } }); }
    headers["content-length"] = String(range.end - range.start + 1);
    if (rangeHeader !== null) headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
    if (input.method === "HEAD") { await close(); return new Response(null, { headers }); }
    let position = range.start;
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    const body = new ReadableStream<Uint8Array>({
      async pull(output) {
        if (finished) { output.error(new Error("File stream closed")); return; }
        try {
          if (file && stamp) {
            const current = await file.stat();
            if (current.size !== stamp.size || current.mtimeMs !== stamp.mtimeMs) throw new Error("File changed");
          }
          if (position > range.end) { await close(); output.close(); return; }
          const length = Math.min(CHUNK, range.end - position + 1);
          const bytes = asset ? asset.read(position, length) : Buffer.alloc(length);
          const read = asset ? { bytesRead: bytes.length } : await file!.read(bytes, 0, bytes.length, position);
          if (finished) { output.error(new Error("File stream cancelled")); return; }
          if (read.bytesRead !== length) throw new Error("File truncated");
          position += read.bytesRead; counters.bytesRead += read.bytesRead;
          output.enqueue(bytes);
        } catch { await close(); output.error(new Error("File stream unavailable")); }
      },
      async cancel() { await close(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: rangeHeader === null ? 200 : 206, headers });
  } catch { await close(); return fail(input.method, 404, "ファイルを読み込めません"); }
}
