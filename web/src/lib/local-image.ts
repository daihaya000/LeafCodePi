import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { browseAllowedRoots, isAllowedBrowsePath } from "@/lib/browse-paths";
import { getProject, getTask } from "@/lib/store";

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

function taskImageRoots(cwd: string): string[] {
  return [...new Set([...browseAllowedRoots(), cwd, homedir(), tmpdir()])];
}

/** Serve only recognized raster images inside an existing task's trusted roots. */
export function readTaskLocalImage(taskId: string, requestedPath: string): LocalImageResult {
  if (!requestedPath || requestedPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(requestedPath)) {
    return failure(400, "画像パスが不正です");
  }
  // Never resolve UNC/device paths: on Windows this can disclose credentials to a remote host.
  if (/^[\\/]{2}/.test(requestedPath) || /^[A-Za-z]:[^\\/]/.test(requestedPath)) {
    return failure(400, "ネットワーク・ドライブ相対パスは表示できません");
  }
  const task = getTask(taskId);
  if (!task) return failure(404, "タスクが見つかりません");

  const project = task.projectId ? getProject(task.projectId) : undefined;
  const cwd = project?.rootPath || task.directory;
  if (!cwd) return failure(404, "作業フォルダーが見つかりません");
  const expanded = requestedPath === "~" || requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
    ? resolve(homedir(), requestedPath.slice(2))
    : requestedPath;
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  if (!isAllowedBrowsePath(target, { roots: taskImageRoots(cwd) })) {
    return failure(403, "この場所の画像は表示できません");
  }

  const expectedMime = IMAGE_MIME_BY_EXTENSION[extname(target).toLowerCase()];
  if (!expectedMime) return failure(415, "PNG・JPEG・GIF・WebP・AVIF・BMPのみ表示できます");

  try {
    const realPath = realpathSync.native(target);
    const info = statSync(realPath);
    if (!info.isFile()) return failure(400, "画像ファイルを指定してください");
    if (info.size <= 0) return failure(400, "空の画像は表示できません");
    if (info.size > MAX_LOCAL_IMAGE_BYTES) return failure(413, "画像は32 MB以下にしてください");
    const bytes = readFileSync(realPath);
    if (bytes.length > MAX_LOCAL_IMAGE_BYTES) return failure(413, "画像は32 MB以下にしてください");
    const mime = imageMimeFromBytes(bytes);
    if (!mime || mime !== expectedMime) return failure(415, "画像形式を確認できません");
    return { ok: true, bytes, mime };
  } catch {
    return failure(404, "画像が見つからないか読み込めません");
  }
}
