import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";

export type ProviderModelState = {
  disabled: Record<string, true>;
  providerOrder: string[];
  modelOrder: Record<string, string[]>;
};

function emptyState(): ProviderModelState {
  return {
    disabled: {},
    providerOrder: [],
    modelOrder: {},
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
    return { disabled, providerOrder, modelOrder };
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

export async function setProviderModelDisabled(
  key: string,
  disabled: boolean,
  accountId?: string | null,
): Promise<void> {
  const storageKey = accountId ? `${accountId}::${key}` : key;
  await withStateLock((state) => {
    if (disabled) state.disabled[storageKey] = true;
    else delete state.disabled[storageKey];
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
