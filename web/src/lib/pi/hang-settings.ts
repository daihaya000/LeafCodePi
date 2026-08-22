import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";
import {
  DEFAULT_HANG_TIMEOUT_MS,
  HANG_TIMEOUT_SETTING_KEY,
  clampHangTimeoutMs,
} from "@/lib/hang-timeout";

type WebSettingsFile = {
  version: 1;
  [HANG_TIMEOUT_SETTING_KEY]?: number;
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

export function readHangTimeoutSettingMs(): number {
  const raw = readSettings()[HANG_TIMEOUT_SETTING_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_HANG_TIMEOUT_MS;
  return clampHangTimeoutMs(raw);
}

export function writeHangTimeoutSettingMs(value: number): number {
  const normalized = clampHangTimeoutMs(value);
  const settings = readSettings();
  settings[HANG_TIMEOUT_SETTING_KEY] = normalized;
  writeSettings(settings);
  return normalized;
}
