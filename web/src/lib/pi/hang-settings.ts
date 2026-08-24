import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";
import {
  AUTO_RESUME_MODE_SETTING_KEY,
  DEFAULT_HANG_TIMEOUT_MS,
  DEFAULT_AUTO_RESUME_MODE,
  HANG_TIMEOUT_SETTING_KEY,
  clampHangTimeoutMs,
  isAutoResumeMode,
  type AutoResumeMode,
} from "@/lib/hang-timeout";

type WebSettingsFile = {
  version: 1;
  [HANG_TIMEOUT_SETTING_KEY]?: number;
  [AUTO_RESUME_MODE_SETTING_KEY]?: AutoResumeMode;
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

export function readAutoResumeModeSetting(): AutoResumeMode {
  const raw = readSettings()[AUTO_RESUME_MODE_SETTING_KEY];
  return isAutoResumeMode(raw) ? raw : DEFAULT_AUTO_RESUME_MODE;
}

export function writeAutoResumeModeSetting(mode: AutoResumeMode): AutoResumeMode {
  const normalized = isAutoResumeMode(mode) ? mode : DEFAULT_AUTO_RESUME_MODE;
  const settings = readSettings();
  settings[AUTO_RESUME_MODE_SETTING_KEY] = normalized;
  writeSettings(settings);
  return normalized;
}
