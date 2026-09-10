import type { ModelOption } from "@/lib/types";

export const MODELS_CACHE_STORAGE_KEY = "webui:models-cache";
export const MODELS_CACHE_VERSION = 1;
/** アイドル後の /api/models 再構築待ちでも、直近一覧を即表示するための猶予。 */
export const MODELS_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

type ModelsCacheEntry = {
  at: number;
  models: ModelOption[];
};

type StoredModelsCache = {
  version: typeof MODELS_CACHE_VERSION;
  at: number;
  models: ModelOption[];
};

let memoryCache: ModelsCacheEntry | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelOption(value: unknown): value is ModelOption {
  if (!isRecord(value)) return false;
  return (
    typeof value.value === "string" &&
    typeof value.label === "string" &&
    typeof value.providerID === "string" &&
    typeof value.modelID === "string"
  );
}

function isFresh(entry: ModelsCacheEntry, now: number): boolean {
  const age = now - entry.at;
  return age >= 0 && age < MODELS_CACHE_MAX_AGE_MS && entry.models.length > 0;
}

function readStored(now: number): ModelsCacheEntry | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(MODELS_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== MODELS_CACHE_VERSION) return null;
    if (typeof parsed.at !== "number" || !Array.isArray(parsed.models)) return null;
    if (!parsed.models.every(isModelOption) || parsed.models.length === 0) return null;
    const entry = { at: parsed.at, models: parsed.models };
    return isFresh(entry, now) ? entry : null;
  } catch {
    return null;
  }
}

/** 直近のモデル一覧。期限切れ・空・壊れた値は null。 */
export function readCachedModels(now = Date.now()): ModelOption[] | null {
  if (memoryCache && isFresh(memoryCache, now)) return memoryCache.models;
  const stored = readStored(now);
  if (!stored) {
    memoryCache = null;
    return null;
  }
  memoryCache = stored;
  return stored.models;
}

/** 空一覧はキャッシュしない（復旧待ちの loading を隠さない）。 */
export function writeCachedModels(models: ModelOption[], now = Date.now()): boolean {
  if (!Array.isArray(models) || models.length === 0) return false;
  if (!models.every(isModelOption)) return false;
  const entry: ModelsCacheEntry = { at: now, models };
  memoryCache = entry;
  if (typeof sessionStorage === "undefined") return true;
  try {
    const payload: StoredModelsCache = {
      version: MODELS_CACHE_VERSION,
      at: now,
      models,
    };
    sessionStorage.setItem(MODELS_CACHE_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return true;
  }
}

export function clearCachedModels(): void {
  memoryCache = null;
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(MODELS_CACHE_STORAGE_KEY);
  } catch {
    /* private mode 等 */
  }
}
