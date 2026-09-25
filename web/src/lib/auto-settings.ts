import { createSettingSync, type SettingSync } from "@/lib/setting-sync";
import {
  AUTO_JEV_ENABLED_SETTING_KEY,
  AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY,
  isAutoJevEnabled,
  parseAutoJevMinConfidence,
} from "@/lib/auto-jev-settings";
import {
  AUTO_MODEL_ENABLED_SETTING_KEY,
  DEFAULT_AUTO_OPTIMIZE_MODE,
  EMPTY_AUTO_ROUTE_CONFIG,
  isAutoOptimizeMode,
  isAutoRouteConfigEmpty,
  normalizeAutoRouteConfig,
  type AutoOptimizeMode,
  type AutoRouteConfig,
} from "@/lib/auto-model";

const OPTIMIZE_STORAGE_KEY = "webui:auto-optimize";
const MODEL_ENABLED_STORAGE_KEY = "webui:auto-model-enabled";
const SHOW_MODEL_STORAGE_KEY = "webui:auto-show-model";
const ROUTE_CONFIG_STORAGE_KEY = "webui:auto-route-overrides";
const JEV_ENABLED_STORAGE_KEY = "webui:auto-jev-enabled";
const JEV_MIN_CONFIDENCE_STORAGE_KEY = "webui:auto-jev-min-confidence";

export const AUTO_OPTIMIZE_EVENT = "webui:auto-optimize";
export const AUTO_MODEL_ENABLED_EVENT = "webui:auto-model-enabled";
export const AUTO_SHOW_MODEL_EVENT = "webui:auto-show-model";
export const AUTO_ROUTE_OVERRIDES_EVENT = "webui:auto-route-overrides";
export const AUTO_JEV_ENABLED_EVENT = "webui:auto-jev-enabled";
export const AUTO_JEV_MIN_CONFIDENCE_EVENT = "webui:auto-jev-min-confidence";

export const AUTO_OPTIMIZE_SETTING_KEY = "auto-optimize";
export { AUTO_MODEL_ENABLED_SETTING_KEY };
export const AUTO_SHOW_MODEL_SETTING_KEY = "auto-show-model";
export const AUTO_ROUTE_OVERRIDES_SETTING_KEY = "auto-route-overrides";
export { AUTO_JEV_ENABLED_SETTING_KEY, AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY };

export type AutoSettingKey =
  | typeof AUTO_OPTIMIZE_SETTING_KEY
  | typeof AUTO_MODEL_ENABLED_SETTING_KEY
  | typeof AUTO_SHOW_MODEL_SETTING_KEY
  | typeof AUTO_ROUTE_OVERRIDES_SETTING_KEY
  | typeof AUTO_JEV_ENABLED_SETTING_KEY
  | typeof AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY;

const syncByKey: Record<AutoSettingKey, SettingSync> = {
  [AUTO_OPTIMIZE_SETTING_KEY]: createSettingSync({
    storageKey: OPTIMIZE_STORAGE_KEY,
    serverPath: `/api/settings/${AUTO_OPTIMIZE_SETTING_KEY}`,
    eventName: AUTO_OPTIMIZE_EVENT,
    // 起動時は Composer 既定値の effort で毎回上書きするため hydrate しない。
    hydrate: false,
  }),
  [AUTO_MODEL_ENABLED_SETTING_KEY]: createSettingSync({
    storageKey: MODEL_ENABLED_STORAGE_KEY,
    serverPath: `/api/settings/${AUTO_MODEL_ENABLED_SETTING_KEY}`,
    eventName: AUTO_MODEL_ENABLED_EVENT,
  }),
  [AUTO_SHOW_MODEL_SETTING_KEY]: createSettingSync({
    storageKey: SHOW_MODEL_STORAGE_KEY,
    serverPath: `/api/settings/${AUTO_SHOW_MODEL_SETTING_KEY}`,
    eventName: AUTO_SHOW_MODEL_EVENT,
  }),
  [AUTO_ROUTE_OVERRIDES_SETTING_KEY]: createSettingSync({
    storageKey: ROUTE_CONFIG_STORAGE_KEY,
    serverPath: `/api/settings/${AUTO_ROUTE_OVERRIDES_SETTING_KEY}`,
    eventName: AUTO_ROUTE_OVERRIDES_EVENT,
  }),
  [AUTO_JEV_ENABLED_SETTING_KEY]: createSettingSync({
    storageKey: JEV_ENABLED_STORAGE_KEY,
    serverPath: `/api/settings/${AUTO_JEV_ENABLED_SETTING_KEY}`,
    eventName: AUTO_JEV_ENABLED_EVENT,
  }),
  [AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY]: createSettingSync({
    storageKey: JEV_MIN_CONFIDENCE_STORAGE_KEY,
    serverPath: `/api/settings/${AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY}`,
    eventName: AUTO_JEV_MIN_CONFIDENCE_EVENT,
  }),
};

const storageKeyBySetting: Record<AutoSettingKey, string> = {
  [AUTO_OPTIMIZE_SETTING_KEY]: OPTIMIZE_STORAGE_KEY,
  [AUTO_MODEL_ENABLED_SETTING_KEY]: MODEL_ENABLED_STORAGE_KEY,
  [AUTO_SHOW_MODEL_SETTING_KEY]: SHOW_MODEL_STORAGE_KEY,
  [AUTO_ROUTE_OVERRIDES_SETTING_KEY]: ROUTE_CONFIG_STORAGE_KEY,
  [AUTO_JEV_ENABLED_SETTING_KEY]: JEV_ENABLED_STORAGE_KEY,
  [AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY]: JEV_MIN_CONFIDENCE_STORAGE_KEY,
};

const eventBySetting: Record<AutoSettingKey, string> = {
  [AUTO_OPTIMIZE_SETTING_KEY]: AUTO_OPTIMIZE_EVENT,
  [AUTO_MODEL_ENABLED_SETTING_KEY]: AUTO_MODEL_ENABLED_EVENT,
  [AUTO_SHOW_MODEL_SETTING_KEY]: AUTO_SHOW_MODEL_EVENT,
  [AUTO_ROUTE_OVERRIDES_SETTING_KEY]: AUTO_ROUTE_OVERRIDES_EVENT,
  [AUTO_JEV_ENABLED_SETTING_KEY]: AUTO_JEV_ENABLED_EVENT,
  [AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY]: AUTO_JEV_MIN_CONFIDENCE_EVENT,
};

export function readAutoOptimizeMode(): AutoOptimizeMode {
  const raw = syncByKey[AUTO_OPTIMIZE_SETTING_KEY].read();
  return isAutoOptimizeMode(raw) ? raw : DEFAULT_AUTO_OPTIMIZE_MODE;
}

export function writeAutoOptimizeMode(mode: AutoOptimizeMode): void {
  syncByKey[AUTO_OPTIMIZE_SETTING_KEY].write(mode);
}

export function readAutoModelEnabled(): boolean {
  // Auto model is opt-in. Keep an explicit "1" enabled, but treat an
  // unset setting as disabled for new installations.
  return syncByKey[AUTO_MODEL_ENABLED_SETTING_KEY].read() === "1";
}

export function writeAutoModelEnabled(enabled: boolean): void {
  syncByKey[AUTO_MODEL_ENABLED_SETTING_KEY].write(enabled ? "1" : "0");
}

export function readAutoShowModel(): boolean {
  return syncByKey[AUTO_SHOW_MODEL_SETTING_KEY].read() === "1";
}

export function writeAutoShowModel(enabled: boolean): void {
  syncByKey[AUTO_SHOW_MODEL_SETTING_KEY].write(enabled ? "1" : null);
}

export function readAutoJevEnabled(): boolean {
  return isAutoJevEnabled(syncByKey[AUTO_JEV_ENABLED_SETTING_KEY].read());
}

export function writeAutoJevEnabled(enabled: boolean): void {
  syncByKey[AUTO_JEV_ENABLED_SETTING_KEY].write(enabled ? "1" : null);
}

export function readAutoJevMinConfidence(): number {
  return parseAutoJevMinConfidence(
    syncByKey[AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY].read(),
  );
}

export function writeAutoJevMinConfidence(minConfidence: number): void {
  syncByKey[AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY].write(String(minConfidence));
}

export function readAutoRouteConfig(): AutoRouteConfig {
  const raw = syncByKey[AUTO_ROUTE_OVERRIDES_SETTING_KEY].read();
  if (!raw) return EMPTY_AUTO_ROUTE_CONFIG;
  try {
    return normalizeAutoRouteConfig(JSON.parse(raw));
  } catch {
    return EMPTY_AUTO_ROUTE_CONFIG;
  }
}

export function writeAutoRouteConfig(config: AutoRouteConfig): void {
  const normalized = normalizeAutoRouteConfig(config);
  syncByKey[AUTO_ROUTE_OVERRIDES_SETTING_KEY].write(
    isAutoRouteConfigEmpty(normalized) ? null : JSON.stringify(normalized),
  );
}

export function hasStoredAutoSetting(key: AutoSettingKey): boolean {
  const raw = syncByKey[key].read();
  if (raw === null) return false;
  switch (key) {
    case AUTO_OPTIMIZE_SETTING_KEY:
      return isAutoOptimizeMode(raw);
    case AUTO_MODEL_ENABLED_SETTING_KEY:
      return raw === "0" || raw === "1";
    case AUTO_SHOW_MODEL_SETTING_KEY:
      return raw === "1";
    case AUTO_ROUTE_OVERRIDES_SETTING_KEY:
      try {
        return !isAutoRouteConfigEmpty(normalizeAutoRouteConfig(JSON.parse(raw)));
      } catch {
        return false;
      }
    case AUTO_JEV_ENABLED_SETTING_KEY:
      return isAutoJevEnabled(raw);
    case AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY:
      return String(parseAutoJevMinConfidence(raw)) === raw;
  }
}

export function subscribeAutoSetting(
  key: AutoSettingKey,
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKeyBySetting[key] || event.key === null) listener();
  };
  window.addEventListener(eventBySetting[key], listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(eventBySetting[key], listener);
    window.removeEventListener("storage", onStorage);
  };
}

export type AutoSettingsSnapshot = {
  mode?: AutoOptimizeMode;
  modelEnabled?: boolean;
  showModel?: boolean;
  routeConfig?: AutoRouteConfig;
  jevEnabled?: boolean;
  jevMinConfidence?: number;
};

export async function readAutoSettingsFromServer(): Promise<AutoSettingsSnapshot> {
  if (typeof window === "undefined") return {};
  const [mode, showModel, routeConfig, jevEnabled, jevMinConfidence, modelEnabled] = await Promise.all([
    syncByKey[AUTO_OPTIMIZE_SETTING_KEY].readFromServer(),
    syncByKey[AUTO_SHOW_MODEL_SETTING_KEY].readFromServer(),
    syncByKey[AUTO_ROUTE_OVERRIDES_SETTING_KEY].readFromServer(),
    syncByKey[AUTO_JEV_ENABLED_SETTING_KEY].readFromServer(),
    syncByKey[AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY].readFromServer(),
    syncByKey[AUTO_MODEL_ENABLED_SETTING_KEY].readFromServer(),
  ]);
  const snapshot: AutoSettingsSnapshot = {};
  if (isAutoOptimizeMode(mode)) snapshot.mode = mode;
  if (modelEnabled === "0" || modelEnabled === "1") snapshot.modelEnabled = modelEnabled === "1";
  if (showModel !== null) snapshot.showModel = showModel === "1";
  if (jevEnabled !== null) snapshot.jevEnabled = isAutoJevEnabled(jevEnabled);
  if (jevMinConfidence !== null) {
    const parsed = parseAutoJevMinConfidence(jevMinConfidence);
    if (String(parsed) === jevMinConfidence) snapshot.jevMinConfidence = parsed;
  }
  if (routeConfig) {
    try {
      const normalized = normalizeAutoRouteConfig(JSON.parse(routeConfig));
      if (!isAutoRouteConfigEmpty(normalized)) snapshot.routeConfig = normalized;
    } catch {
      /* Ignore a corrupted server copy; the preset remains usable. */
    }
  }
  return snapshot;
}

export async function writeAutoSettingToServer(
  key: AutoSettingKey,
  value: string | null,
): Promise<void> {
  await syncByKey[key].writeToServer(value);
}
