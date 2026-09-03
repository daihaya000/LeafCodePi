import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";

/**
 * 文字列設定の永続バックアップ（本家 LeafCode の settings 表相当）。
 * hang-settings.ts と同じ web-settings.json を共有し、read/write もここへ集約する
 * （旧: hang-settings.ts が同じファイルを別実装で読み書きしており、開発サーバの
 * 再起動やクラッシュで書き込み途中のファイルが読まれて設定が丸ごと消える障害があった）。
 * localStorage が同期読み取りの正本で、ここは永続バックアップ。
 */
export type WebSettingsFile = {
  version: 1;
  [key: string]: unknown;
};

function settingsPath(): string {
  return join(dataDir(), "web-settings.json");
}

/** 破損・欠損時は空設定へフォールバック（例外で他設定まで巻き込まない）。 */
export function readSettingsFile(): WebSettingsFile {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as WebSettingsFile;
    if (!parsed || parsed.version !== 1) return { version: 1 };
    return parsed;
  } catch {
    return { version: 1 };
  }
}

/**
 * 一時ファイルへ書いてから rename する原子的書き込み。
 * 直接上書きだとプロセスが書き込み途中で落ちた（サーバ再起動・クラッシュ）場合に
 * ファイルが壊れ、readSettingsFile が JSON.parse 失敗で全設定を失っていた。
 * rename は POSIX/Windows とも既存ファイルへの上書きを含めて原子的。
 */
export function writeSettingsFile(settings: WebSettingsFile): void {
  const file = settingsPath();
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.web-settings.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

const readSettings = readSettingsFile;
const writeSettings = writeSettingsFile;

/** 最大 4KB。この BFF は認証なしで LAN から到達可能なため。 */
export const MAX_SETTING_VALUE_CHARS = 4096;

export function getSetting(key: string): string | null {
  const raw = readSettings()[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function setSetting(key: string, value: string | null): void {
  const settings = readSettings();
  if (value === null || value.length === 0) delete settings[key];
  else settings[key] = value;
  writeSettings(settings);
}
