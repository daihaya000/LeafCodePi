import { readSettingsFile, updateSettingsFile } from "@/lib/pi/web-settings";
import {
  AUTO_RESUME_MODE_SETTING_KEY,
  DEFAULT_HANG_TIMEOUT_MS,
  DEFAULT_AUTO_RESUME_MODE,
  HANG_TIMEOUT_SETTING_KEY,
  clampHangTimeoutMs,
  isAutoResumeMode,
  type AutoResumeMode,
} from "@/lib/hang-timeout";

// web-settings.ts と同じ web-settings.json を共有するため、read/update は共通実装を使う。
export function readHangTimeoutSettingMs(): number {
  const raw = readSettingsFile()[HANG_TIMEOUT_SETTING_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_HANG_TIMEOUT_MS;
  return clampHangTimeoutMs(raw);
}

export function writeHangTimeoutSettingMs(value: number): number {
  const normalized = clampHangTimeoutMs(value);
  return updateSettingsFile((settings) => {
    settings[HANG_TIMEOUT_SETTING_KEY] = normalized;
    return normalized;
  });
}

export function readAutoResumeModeSetting(): AutoResumeMode {
  const raw = readSettingsFile()[AUTO_RESUME_MODE_SETTING_KEY];
  return isAutoResumeMode(raw) ? raw : DEFAULT_AUTO_RESUME_MODE;
}

export function writeAutoResumeModeSetting(mode: AutoResumeMode): AutoResumeMode {
  const normalized = isAutoResumeMode(mode) ? mode : DEFAULT_AUTO_RESUME_MODE;
  return updateSettingsFile((settings) => {
    settings[AUTO_RESUME_MODE_SETTING_KEY] = normalized;
    return normalized;
  });
}
