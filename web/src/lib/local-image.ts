import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";
import { resolveTaskLocalFile } from "@/lib/local-file";

export const MAX_LOCAL_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export type LocalImageResult =
  | { ok: true; bytes: Buffer; mime: string }
  | { ok: false; status: number; error: string };

function failure(status: number, error: string): LocalImageResult {
  return { ok: false, status, error };
}

function imageMimeFromBytes(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 4, 8) === "ftyp" &&
    /^(?:avif|avis)$/.test(bytes.toString("ascii", 8, 12))
  ) {
    return "image/avif";
  }
  if (bytes.length >= 2 && bytes.toString("ascii", 0, 2) === "BM") {
    return "image/bmp";
  }
  return null;
}

type ImageFailure = Extract<LocalImageResult, { ok: false }>;
function withTaskLocalImage<T>(taskId: string, requestedPath: string, consume: (fd: number, size: number, mime: string) => T): T | ImageFailure {
  const resolved = resolveTaskLocalFile(taskId, requestedPath);
  if (!resolved.ok) return resolved;
  const expectedMime = IMAGE_MIME_BY_EXTENSION[extname(requestedPath).toLowerCase()];
  if (!expectedMime) return { ok: false, status: 415, error: "PNG・JPEG・GIF・WebP・AVIF・BMPのみ表示できます" };
  let fd: number | undefined;
  try {
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
    fd = openSync(resolved.path, flags);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size <= 0) return { ok: false, status: 400, error: "空ではない画像ファイルを指定してください" };
    if (info.size > MAX_LOCAL_IMAGE_BYTES) return { ok: false, status: 413, error: "画像は32 MB以下にしてください" };
    const header = Buffer.alloc(32);
    const length = readSync(fd, header, 0, header.length, 0);
    const mime = imageMimeFromBytes(header.subarray(0, length));
    if (!mime || mime !== expectedMime) return { ok: false, status: 415, error: "画像形式を確認できません" };
    return consume(fd, info.size, mime);
  } catch {
    return { ok: false, status: 404, error: "画像が見つからないか読み込めません" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Registration needs only the bounded header, not up to 32 MB of pixels per image. */
export function validateTaskLocalImage(taskId: string, requestedPath: string) {
  return withTaskLocalImage(taskId, requestedPath, () => ({ ok: true as const }));
}

/** Serve a bounded snapshot from the same verified descriptor, even if the file grows during reading. */
export function readTaskLocalImage(taskId: string, requestedPath: string): LocalImageResult {
  return withTaskLocalImage(taskId, requestedPath, (fd, size, mime): LocalImageResult => {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (!count) break;
      offset += count;
    }
    const currentSize = fstatSync(fd).size;
    if (currentSize > MAX_LOCAL_IMAGE_BYTES) return failure(413, "画像は32 MB以下にしてください");
    if (offset !== size || currentSize !== size || imageMimeFromBytes(bytes) !== mime) {
      return failure(409, "読み込み中に画像が変更されました");
    }
    return { ok: true, bytes, mime };
  });
}
