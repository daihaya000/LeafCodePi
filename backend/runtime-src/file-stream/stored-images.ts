import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getProjectIcon } from "@/lib/store";
import { getLinkPreviewImage, readLinkPreviewImageDiagnostics } from "@/lib/link-preview";
import { projectIconVersion } from "../lib/project-icon-url";
import { imageMimeFromBytes } from "../lib/raster-image";
const MAX_IMAGE = 2 * 1024 * 1024;
export type StoredImage = { size: number; mime: string; cacheControl: string; headers?: Record<string,string>; read(position: number, length: number): Buffer; release(): void };
export { readLinkPreviewImageDiagnostics };
type Result = { ok: true; image: StoredImage } | { ok: false; status: number; error: string };
const fail = (status: number, error: string): Result => ({ ok: false, status, error });
/** Existing cache/store representations stay on Backend; no full base64 decoding or browser URL fetch. */
export async function openStoredImage(kind: "project-icon" | "preview-image", id: string, url: string, signal: AbortSignal): Promise<Result> {
  assertConfigurationOwner();
  if (signal.aborted) return fail(400, "画像配信が中断されました");
  if (kind === "preview-image") {
    const data = await getLinkPreviewImage(new URL(url).searchParams.get("id") ?? "", signal);
    if (!data) return fail(404, "プレビュー画像を取得できません");
    if (!data.bytes.length || data.bytes.length > MAX_IMAGE || imageMimeFromBytes(data.bytes.subarray(0,32)) !== data.mime) return fail(415, "プレビュー画像形式を確認できません");
    let bytes: Buffer | undefined = data.bytes;
    return { ok: true, image: { size: bytes.length, mime: data.mime, cacheControl: "private, max-age=300", headers: { "referrer-policy": "no-referrer" },
      read(position, length) { if (!bytes) throw new Error("Image released"); return bytes.subarray(position, position + length); },
      release() { bytes = undefined; },
    } };
  }
  let icon: string | undefined = getProjectIcon(id);
  if (!icon) return fail(404, "icon not found");
  if (icon.length > 4 * Math.ceil(MAX_IMAGE / 3) + 128) return fail(413, "アイコンは2 MiB以下にしてください");
  const match = /^data:(image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/]*={0,2})$/.exec(icon);
  if (!match || !match[2].length || match[2].length % 4) return fail(404, "icon not found");
  const encoded = match[2], padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const size = encoded.length / 4 * 3 - padding;
  if (!size || size > MAX_IMAGE) return fail(413, "アイコンは2 MiB以下にしてください");
  if (padding) {
    const digit = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(encoded.at(-padding - 1)!);
    if (digit & (padding === 2 ? 15 : 3)) return fail(415, "アイコン形式を確認できません");
  }
  const mime = match[1], prefix = icon.length - encoded.length;
  const header = Buffer.from(encoded.slice(0, 44), "base64");
  const signature = imageMimeFromBytes(header);
  const ico = header.length >= 6 && header[0] === 0 && header[1] === 0 && header[2] === 1 && header[3] === 0;
  if (signature !== mime && !(ico && ["image/x-icon", "image/vnd.microsoft.icon"].includes(mime))) return fail(415, "アイコン形式を確認できません");
  const cacheControl = new URL(url).searchParams.get("v") === projectIconVersion(icon) ? "private, max-age=31536000, immutable" : "private, no-cache";
  return { ok: true, image: { size, mime, cacheControl,
    read(position, length) {
      if (!icon) throw new Error("Icon released");
      const start = Math.floor(position / 3) * 4, end = Math.ceil((position + length) / 3) * 4;
      return Buffer.from(icon.slice(prefix + start, prefix + end), "base64").subarray(position % 3, position % 3 + length);
    },
    release() { icon = undefined; },
  } };
}
