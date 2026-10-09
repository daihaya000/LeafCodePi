import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { resolveTaskLocalFile, type LocalFileFailure } from "@/lib/local-file";
import { mediaFormatForPath, type MediaFormat, type MediaKind } from "@/lib/media-formats";

export const MAX_LOCAL_MEDIA_BYTES = 512 * 1024 * 1024;
export type LocalMediaResult = LocalFileFailure | { ok: true; file: FileHandle; size: number; mime: string; kind: MediaKind };

function validHeader(header: Buffer, signature: MediaFormat["signature"]): boolean {
  switch (signature) {
    case "mp4": return header.length >= 16 && header.toString("ascii", 4, 8) === "ftyp" &&
      /^(?:isom|iso[2-9]|mp4[12]|M4[AVB] |qt  |dash)$/.test(header.toString("ascii", 8, 12));
    case "webm": return header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      header.includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
    case "wav": return header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE";
    case "flac": return header.toString("ascii", 0, 4) === "fLaC";
    case "ogg": return header.toString("ascii", 0, 4) === "OggS" &&
      (header.includes(Buffer.from("OpusHead")) || header.includes(Buffer.from([1, ...Buffer.from("vorbis")])));
    case "aac": return header.length >= 7 && header[0] === 0xff && (header[1] & 0xf6) === 0xf0;
    case "mp3": return (header.length >= 10 && header.toString("ascii", 0, 3) === "ID3" &&
      header[3] >= 2 && header[3] <= 4 && header.subarray(6, 10).every((byte) => byte < 0x80)) || (header.length >= 4 &&
      header[0] === 0xff && (header[1] & 0xe0) === 0xe0 && (header[1] & 6) !== 0 &&
      (header[1] & 0x18) !== 8 && (header[2] & 0xf0) !== 0xf0 && (header[2] & 0x0c) !== 0x0c);
  }
}

/** Open one authorized file, inspect only its header, and keep that descriptor for streaming. Caller must close it. */
export async function openTaskLocalMedia(taskId: string, path: string): Promise<LocalMediaResult> {
  const resolved = resolveTaskLocalFile(taskId, path);
  if (!resolved.ok) return resolved;
  const format = mediaFormatForPath(path);
  if (!format) return { ok: false, status: 415, error: "対応する動画・音声ファイルを指定してください" };
  let file: FileHandle | undefined;
  const fail = async (status: number, error: string): Promise<LocalFileFailure> => {
    await file?.close().catch(() => {});
    file = undefined;
    return { ok: false, status, error };
  };
  try {
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
    file = await open(resolved.path, flags);
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0) return await fail(400, "空ではない動画・音声ファイルを指定してください");
    if (info.size > MAX_LOCAL_MEDIA_BYTES) return await fail(413, "動画・音声は512 MB以下にしてください");
    const canonical = await realpath(resolved.path), current = await stat(canonical);
    if (canonical !== resolved.path || current.dev !== info.dev || current.ino !== info.ino) return await fail(403, "ファイルの場所が変更されました");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (!validHeader(buffer.subarray(0, bytesRead), format.signature)) return await fail(415, "動画・音声の形式を確認できません");
    return { ok: true, file, size: info.size, mime: format.mime, kind: format.kind };
  } catch {
    return await fail(404, "動画・音声が見つからないか読み込めません");
  }
}

export async function validateTaskLocalMedia(taskId: string, path: string, kind: MediaKind) {
  const result = await openTaskLocalMedia(taskId, path);
  if (!result.ok) return result;
  await result.file.close();
  return result.kind === kind ? { ok: true as const } : { ok: false as const, error: `${kind === "video" ? "動画" : "音声"}ファイルを指定してください` };
}

/** One byte range only. Invalid/unsatisfiable input is null; absent input means the entire file. */
export function parseMediaRange(range: string | null, size: number): { start: number; end: number } | null {
  if (range === null) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  return start < size && end >= start ? { start, end } : null;
}
