import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";

/**
 * 文字列設定の永続バックアップ（本家 LeafCode の settings 表相当）。
 * hang-settings.ts と同じ web-settings.json を共有する。
 * localStorage が同期読み取りの正本で、ここは永続バックアップ。
 */
type WebSettingsFile = {
  version: 1;
  [key: string]: unknown;
};

function settingsPath(): string {
  return join(dataDir(), "web-settings.json");
}

function readSettings(): WebSettingsFile {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as WebSettingsFile;
    if (!parsed || parsed.version !== 1) return { version: 1 };
    return parsed;
  } catch {
    return { version: 1 };
  }
}

function writeSettings(settings: WebSettingsFile): void {
  const file = settingsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

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
