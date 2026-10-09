import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { join, extname } from "node:path";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { normalizeRoom } from "@backend-core/room-normalize.mjs";
import { taskFileTarget } from "@shared/task-file-stream-contract.mjs";
import { dataDir } from "../lib/paths";
import { ROOM_HANDOFF_STATES } from "../lib/types";
import { imageMimeFromBytes } from "../lib/raster-image";

const MAX_METADATA = 8 * 1024 * 1024, MAX_ATTACHMENT = 8 * 1024 * 1024;
const queue: Array<() => void> = [];
let metadataActive = 0, peakMetadataActive = 0, metadataBufferBytes = 0;
const metadataBuffers: Buffer[] = [];
export function readRoomAttachmentDiagnostics() { return { metadataActive, metadataQueued: queue.length, peakMetadataActive, metadataBufferBytes, maxMetadataBytes: MAX_METADATA }; }
async function metadataSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (metadataActive >= 2) await new Promise<void>((resolve, reject) => {
    const granted = () => { signal.removeEventListener("abort", aborted); resolve(); };
    const aborted = () => { const at = queue.indexOf(granted); if (at >= 0) queue.splice(at, 1); signal.removeEventListener("abort", aborted); reject(new Error("Metadata cancelled")); };
    queue.push(granted); signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  else metadataActive++;
  peakMetadataActive = Math.max(metadataActive, peakMetadataActive);
  // The releasing holder reserves the slot for a queued caller before resolving it.
  return () => { const next = queue.shift(); if (next) next(); else metadataActive--; };
}
const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
type Failure = { ok: false; status: number; error: string };
type Success = { ok: true; file: FileHandle; size: number; mime: string; cacheControl: string; disposition: string };
const problem = (status: number, error: string): Failure => ({ ok: false, status, error });
const imageMime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
async function verifiedOpen(path: string): Promise<FileHandle> {
  if (await realpath(path) !== path) throw new Error("Attachment symlink");
  const file = await open(path, flags);
  try {
    const opened = await file.stat();
    // The canonical name must still address this exact descriptor (Windows junctions included).
    const currentPath = await realpath(path);
    const current = await stat(currentPath);
    if (currentPath !== path || current.dev !== opened.dev || current.ino !== opened.ino || !opened.isFile()) throw new Error("Attachment path changed");
    return file;
  } catch (error) { await file.close(); throw error; }
}
/** Bounded metadata snapshot. No mutations, SDK/session hydration, history scans or attachment buffering. */
export async function openRoomAttachment(id: string, name: string, kind: "files" | "images", signal: AbortSignal): Promise<Success | Failure> {
  assertConfigurationOwner();
  const target = taskFileTarget(`bots/rooms/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(name)}`);
  if (!target || (target.kind !== "files" && target.kind !== "images")) return problem(404, "添付経路が不正です");
  let file: FileHandle | undefined;
  try {
    const root = await realpath(join(dataDir(), "bots", "rooms"));
    const release = await metadataSlot(signal);
    let backing: Buffer | undefined;
    let mime = imageMime[extname(name).toLowerCase()], disposition = "inline";
    try {
      signal.throwIfAborted();
      const metadata = await verifiedOpen(join(root, id + ".json"));
      try {
        const info = await metadata.stat();
        if (!info.size || info.size > MAX_METADATA) return problem(503, "Roomメタデータが大きすぎます");
        backing = metadataBuffers.pop();
        if (!backing || backing.length < info.size) {
          metadataBufferBytes += info.size - (backing?.length ?? 0);
          backing = Buffer.allocUnsafe(info.size);
        }
        // Both leases reuse bounded storage; decoding occurs only after every byte was filled.
        const bytes = backing.subarray(0, info.size);
        let offset = 0;
        while (offset < bytes.length) {
          signal.throwIfAborted();
          const item = await metadata.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
          if (!item.bytesRead) throw new Error("Room metadata truncated");
          offset += item.bytesRead;
        }
        const current = await metadata.stat();
        if (current.size !== info.size || current.mtimeMs !== info.mtimeMs) return problem(409, "Roomメタデータが変更されました");
        const room = normalizeRoom(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), id, ROOM_HANDOFF_STATES);
        if (!room) return problem(404, "Roomが見つかりません");
        if (kind === "files") {
          const item = room.messages.flatMap(message => message.files ?? []).find(item => item.file === name);
          if (!item) return problem(404, "ファイルが見つかりません");
          if (!item.name || item.name.length > 1024 || /[\u0000-\u001f\u007f]/.test(item.name) ||
              !item.mimeType || item.mimeType.length > 128 || !/^[\x20-\x7e]+$/.test(item.mimeType)) return problem(503, "添付情報を確認できません");
          // Do not keep the full parsed Room or backing JSON string alive during file admission.
          mime = Buffer.from(item.mimeType, "ascii").toString("ascii");
          disposition = `attachment; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase())}`;
        }
        // Images retain the original Room-existence/generated-name policy after history overflow/reset.
      } finally { await metadata.close(); }
    } finally { if (backing) metadataBuffers.push(backing); release(); }
    signal.throwIfAborted();
    file = await verifiedOpen(join(root, id, kind, name));
    const info = await file.stat();
    if (info.size > MAX_ATTACHMENT) return problem(413, "Room添付は8 MiB以下にしてください");
    if (!info.size) return problem(400, "添付ファイルが空です");
    if (kind === "images") {
      const header = Buffer.alloc(32), read = await file.read(header, 0, header.length, 0);
      if (imageMimeFromBytes(header.subarray(0, read.bytesRead)) !== mime) return problem(415, "画像形式を確認できません");
    }
    signal.throwIfAborted();
    const result: Success = { ok: true, file, size: info.size, mime, disposition, cacheControl: "private, max-age=31536000, immutable" };
    file = undefined; // Transfer descriptor ownership to the common bounded stream.
    return result;
  } catch { return problem(404, "Room添付を読み込めません"); }
  finally { await file?.close().catch(() => {}); }
}
