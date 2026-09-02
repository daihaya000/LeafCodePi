import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";

export type ProviderModelState = {
  disabled: Record<string, true>;
  providerOrder: string[];
  modelOrder: Record<string, string[]>;
  contextWindow?: Record<string, number>;
  /** Provider/model keys seen in a previous catalog refresh. */
  knownModels?: Record<string, true>;
};

export type ProviderModelRef = {
  providerID: string;
  modelID: string;
};

function emptyState(): ProviderModelState {
  return {
    disabled: {},
    providerOrder: [],
    modelOrder: {},
    contextWindow: {},
  };
}

export function providerModelStatePath(dir = dataDir()): string {
  return join(dir, "provider-model-state.json");
}

/** アカウント別設定の provider / model キー。共有設定キーとは別名前空間にする。 */
export function accountProviderModelKey(providerID: string, accountId?: string | null): string {
  return accountId ? `${accountId}::${providerID}` : providerID;
}

export function accountModelKey(
  providerID: string,
  modelID: string,
  accountId?: string | null,
): string {
  return `${accountProviderModelKey(providerID, accountId)}::${modelID}`;
}

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${Date.now()}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function readProviderModelState(
  path = providerModelStatePath(),
): ProviderModelState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[provider-model] failed to read state", error);
    }
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProviderModelState>;
    const disabled: Record<string, true> = {};
    if (parsed.disabled && typeof parsed.disabled === "object" && !Array.isArray(parsed.disabled)) {
      for (const [key, value] of Object.entries(parsed.disabled)) {
        if (value === true) disabled[key] = true;
      }
    }
    const knownModels: Record<string, true> | undefined =
      parsed.knownModels && typeof parsed.knownModels === "object" && !Array.isArray(parsed.knownModels)
        ? {}
        : undefined;
    if (knownModels && parsed.knownModels) {
      for (const [key, value] of Object.entries(parsed.knownModels)) {
        if (value === true && key.trim()) knownModels[key] = true;
      }
    }
    const providerOrder = Array.isArray(parsed.providerOrder)
      ? parsed.providerOrder.filter((id): id is string => typeof id === "string")
      : [];
    const modelOrder: Record<string, string[]> = {};
    if (parsed.modelOrder && typeof parsed.modelOrder === "object" && !Array.isArray(parsed.modelOrder)) {
      for (const [providerID, order] of Object.entries(parsed.modelOrder)) {
        if (Array.isArray(order)) {
          modelOrder[providerID] = order.filter((id): id is string => typeof id === "string");
        }
      }
    }
    const contextWindow: Record<string, number> = {};
    if (parsed.contextWindow && typeof parsed.contextWindow === "object" && !Array.isArray(parsed.contextWindow)) {
      for (const [key, value] of Object.entries(parsed.contextWindow)) {
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 4096 && value <= 1_000_000) {
          contextWindow[key] = value;
        }
      }
    }
    return {
      disabled,
      providerOrder,
      modelOrder,
      contextWindow,
      ...(knownModels ? { knownModels } : {}),
    };
  } catch {
    return emptyState();
  }
}

export function writeProviderModelState(
  state: ProviderModelState,
  path = providerModelStatePath(),
): void {
  atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

let writeQueue: Promise<unknown> = Promise.resolve();

function withStateLock<T>(mutate: (state: ProviderModelState) => T): Promise<T> {
  const run = writeQueue.then(async () => {
    const state = readProviderModelState();
    const result = mutate(state);
    writeProviderModelState(state);
    return result;
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

function withStateLockIfChanged<T>(
  mutate: (state: ProviderModelState) => { result: T; changed: boolean },
): Promise<T> {
  const run = writeQueue.then(() => {
    const state = readProviderModelState();
    const { result, changed } = mutate(state);
    if (changed) writeProviderModelState(state);
    return result;
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

export async function ensureProviderModelsKnown(
  models: readonly ProviderModelRef[],
  accountId?: string | null,
): Promise<ProviderModelState> {
  return withStateLockIfChanged((state) => {
    const knownModels = state.knownModels ?? {};
    const initializedByScope = new Map<string, boolean>();
    let changed = false;

    for (const { providerID, modelID } of models) {
      if (!providerID || !modelID) continue;
      const scopeKey = accountProviderModelKey(providerID, accountId);
      let initialized = initializedByScope.get(scopeKey);
      if (initialized === undefined) {
        const prefix = `${scopeKey}::`;
        initialized = Object.keys(knownModels).some((key) => key.startsWith(prefix));
        initializedByScope.set(scopeKey, initialized);
      }
      const modelKey = accountModelKey(providerID, modelID, accountId);
      if (knownModels[modelKey] === true) continue;
      knownModels[modelKey] = true;
      changed = true;
      if (initialized && state.disabled[modelKey] !== true) {
        state.disabled[modelKey] = true;
      }
    }

    if (changed) state.knownModels = knownModels;
    return { result: state, changed };
  });
}

export function isProviderDisabled(
  providerID: string,
  state = readProviderModelState(),
  accountId?: string | null,
): boolean {
  return state.disabled[accountProviderModelKey(providerID, accountId)] === true;
}

export function isModelDisabled(
  providerID: string,
  modelID: string,
  state = readProviderModelState(),
  accountId?: string | null,
): boolean {
  return state.disabled[accountModelKey(providerID, modelID, accountId)] === true;
}

export async function setProviderModelContextWindow(
  providerID: string,
  modelID: string,
  contextWindow: number | null,
  accountId?: string | null,
): Promise<void> {
  await withStateLock((state) => {
    const key = accountModelKey(providerID, modelID, accountId);
    if (contextWindow === null) delete state.contextWindow?.[key];
    else (state.contextWindow ??= {})[key] = contextWindow;
  });
}

export function contextWindowForModel(
  providerID: string,
  modelID: string,
  state = readProviderModelState(),
  accountId?: string | null,
): number | undefined {
  const accountValue = accountId
    ? state.contextWindow?.[accountModelKey(providerID, modelID, accountId)]
    : undefined;
  return accountValue ?? state.contextWindow?.[accountModelKey(providerID, modelID)];
}

export async function setProviderModelDisabled(
  key: string,
  disabled: boolean,
  accountId?: string | null,
  modelIdsToDisableOnEnable?: readonly string[],
): Promise<void> {
  const storageKey = accountId ? `${accountId}::${key}` : key;
  await withStateLock((state) => {
    if (key.includes("::")) {
      (state.knownModels ??= {})[storageKey] = true;
    }
    if (disabled) state.disabled[storageKey] = true;
    else {
      delete state.disabled[storageKey];
      for (const modelID of modelIdsToDisableOnEnable ?? []) {
        const modelKey = accountModelKey(key, modelID, accountId);
        (state.knownModels ??= {})[modelKey] = true;
        state.disabled[modelKey] = true;
      }
    }
  });
}

function mergeKnownOrder(next: string[], existing: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of next) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  for (const id of existing) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}

export async function setProviderModelOrder(input: {
  providerOrder?: string[];
  modelOrder?: Record<string, string[]>;
}): Promise<void> {
  await withStateLock((state) => {
    if (input.providerOrder) {
      state.providerOrder = mergeKnownOrder(input.providerOrder, state.providerOrder);
    }
    if (input.modelOrder) {
      for (const [providerID, order] of Object.entries(input.modelOrder)) {
        state.modelOrder[providerID] = mergeKnownOrder(order, state.modelOrder[providerID] ?? []);
      }
    }
  });
}

export function sortByPreferredOrder<T>(
  items: T[],
  order: string[],
  idOf: (item: T) => string,
): T[] {
  if (order.length === 0) return items;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const aId = idOf(a);
    const bId = idOf(b);
    const aRank = rank.has(aId) ? rank.get(aId)! : Number.MAX_SAFE_INTEGER;
    const bRank = rank.has(bId) ? rank.get(bId)! : Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return aId.localeCompare(bId, "en");
  });
}

/** Test helper: reset the write queue between unit tests. */
export function __resetProviderModelStateQueueForTests(): void {
  writeQueue = Promise.resolve();
}
