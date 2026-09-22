import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

/** プロジェクトアイコンとして受け付ける拡張子→MIME（PATCH /api/projects の検証と同一集合）。 */
export const ICON_FILE_ERROR = "PNG・JPEG・GIF・WebP・ICO・EXE のファイルを選択してください。";

const ICON_FILE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

export const MAX_ICON_FILE_BYTES = 2 * 1024 * 1024;

export type IconFileResult = { ok: true; icon: string; name: string } | { ok: false; error: string };

/** ホスト PC の画像ファイルをプロジェクトアイコン用の data URL へ変換する。 */
export function readIconFileAsDataUrl(filePath: string): IconFileResult {
  const mime = ICON_FILE_MIME.get(extname(filePath).toLowerCase());
  if (!mime) return { ok: false, error: ICON_FILE_ERROR };
  try {
    const info = statSync(filePath);
    if (!info.isFile()) return { ok: false, error: "ファイルを選択してください。" };
    if (info.size > MAX_ICON_FILE_BYTES) return { ok: false, error: "2 MB以下の画像を選択してください。" };
    return {
      ok: true,
      icon: `data:${mime};base64,${readFileSync(filePath).toString("base64")}`,
      name: basename(filePath),
    };
  } catch {
    return { ok: false, error: "ファイルを読み込めませんでした。" };
  }
}
