import { createSettingSync, type SettingSync } from "@/lib/setting-sync";
import {
  DEFAULT_AUTO_OPTIMIZE_MODE,
  EMPTY_AUTO_ROUTE_CONFIG,
  isAutoOptimizeMode,
  isAutoRouteConfigEmpty,
  normalizeAutoRouteConfig,
  type AutoOptimizeMode,
  type AutoRouteConfig,
} from "@/lib/auto-model";

const OPTIMIZE_STORAGE_KEY = "webui:auto-optimize";
const SHOW_MODEL_STORAGE_KEY = "webui:auto-show-model";
const ROUTE_CONFIG_STORAGE_KEY = "webui:auto-route-overrides";

export const AUTO_OPTIMIZE_EVENT = "webui:auto-optimize";
export const AUTO_SHOW_MODEL_EVENT = "webui:auto-show-model";
export const AUTO_ROUTE_OVERRIDES_EVENT = "webui:auto-route-overrides";

export const AUTO_OPTIMIZE_SETTING_KEY = "auto-optimize";
export const AUTO_SHOW_MODEL_SETTING_KEY = "auto-show-model";
export const AUTO_ROUTE_OVERRIDES_SETTING_KEY = "auto-route-overrides";

export type AutoSettingKey =
  | typeof AUTO_OPTIMIZE_SETTING_KEY
  | typeof AUTO_SHOW_MODEL_SETTING_KEY
  | typeof AUTO_ROUTE_OVERRIDES_SETTING_KEY;

const syncByKey: Record<AutoSettingKey, SettingSync> = {
  [AUTO_OPTIMIZE_SETTING_KEY]: createSettingSync({
    storageKey: OPTIMIZE_STORAGE_KEY,
    serverPath: `/api/settings/${AUTO_OPTIMIZE_SETTING_KEY}`,
    eventName: AUTO_OPTIMIZE_EVENT,
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
};

const storageKeyBySetting: Record<AutoSettingKey, string> = {
  [AUTO_OPTIMIZE_SETTING_KEY]: OPTIMIZE_STORAGE_KEY,
  [AUTO_SHOW_MODEL_SETTING_KEY]: SHOW_MODEL_STORAGE_KEY,
  [AUTO_ROUTE_OVERRIDES_SETTING_KEY]: ROUTE_CONFIG_STORAGE_KEY,
};

const eventBySetting: Record<AutoSettingKey, string> = {
  [AUTO_OPTIMIZE_SETTING_KEY]: AUTO_OPTIMIZE_EVENT,
  [AUTO_SHOW_MODEL_SETTING_KEY]: AUTO_SHOW_MODEL_EVENT,
  [AUTO_ROUTE_OVERRIDES_SETTING_KEY]: AUTO_ROUTE_OVERRIDES_EVENT,
};

export function readAutoOptimizeMode(): AutoOptimizeMode {
  const raw = syncByKey[AUTO_OPTIMIZE_SETTING_KEY].read();
  return isAutoOptimizeMode(raw) ? raw : DEFAULT_AUTO_OPTIMIZE_MODE;
}

export function writeAutoOptimizeMode(mode: AutoOptimizeMode): void {
  syncByKey[AUTO_OPTIMIZE_SETTING_KEY].write(mode);
}

export function readAutoShowModel(): boolean {
  return syncByKey[AUTO_SHOW_MODEL_SETTING_KEY].read() === "1";
}

export function writeAutoShowModel(enabled: boolean): void {
  syncByKey[AUTO_SHOW_MODEL_SETTING_KEY].write(enabled ? "1" : null);
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
    case AUTO_SHOW_MODEL_SETTING_KEY:
      return raw === "1";
    case AUTO_ROUTE_OVERRIDES_SETTING_KEY:
      try {
        return !isAutoRouteConfigEmpty(normalizeAutoRouteConfig(JSON.parse(raw)));
      } catch {
        return false;
      }
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
  showModel?: boolean;
  routeConfig?: AutoRouteConfig;
};

export async function readAutoSettingsFromServer(): Promise<AutoSettingsSnapshot> {
  if (typeof window === "undefined") return {};
  const [mode, showModel, routeConfig] = await Promise.all([
    syncByKey[AUTO_OPTIMIZE_SETTING_KEY].readFromServer(),
    syncByKey[AUTO_SHOW_MODEL_SETTING_KEY].readFromServer(),
    syncByKey[AUTO_ROUTE_OVERRIDES_SETTING_KEY].readFromServer(),
  ]);
  const snapshot: AutoSettingsSnapshot = {};
  if (isAutoOptimizeMode(mode)) snapshot.mode = mode;
  if (showModel !== null) snapshot.showModel = showModel === "1";
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
  value: string,
): Promise<void> {
  await syncByKey[key].writeToServer(value);
}
