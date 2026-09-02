import {
  accountModelKey,
  accountProviderModelKey,
  isModelDisabled,
  contextWindowForModel,
  isProviderDisabled,
  readProviderModelState,
  sortByPreferredOrder,
} from "@/lib/provider-model-state";
import type { ModelOption } from "@/lib/types";

export type ProviderModelRow = {
  id: string;
  name: string;
  enabled: boolean;
  contextWindow?: number;
};

export type ProviderModelsRow = {
  id: string;
  name: string;
  enabled: boolean;
  models: ProviderModelRow[];
  /** 設定対象のログインアカウント。未指定は共有プロバイダ設定。 */
  accountId?: string;
  accountLabel?: string;
};

type RuntimeModel = { id: string; name?: string; provider?: string };

type RuntimeLike = {
  getProviders(): readonly { id: string; name: string }[];
  getModels(providerId?: string): readonly RuntimeModel[];
  getModel?: (providerId: string, modelId: string) => { contextWindow?: number } | undefined;
  hasConfiguredAuth(providerId: string): boolean;
};

export type ProviderModelSnapshot = ReadonlyMap<string, readonly RuntimeModel[]>;

export function buildProviderModelsCatalog(
  runtime: RuntimeLike,
  state = readProviderModelState(),
  accountId?: string,
  modelSnapshot?: ProviderModelSnapshot,
): ProviderModelsRow[] {
  const rows: ProviderModelsRow[] = [];
  for (const provider of runtime.getProviders()) {
    if (!runtime.hasConfiguredAuth(provider.id)) continue;
    const models = (modelSnapshot?.get(provider.id) ?? runtime.getModels(provider.id)).map((model) => {
      const modelID = model.id;
      const modelKey = accountModelKey(provider.id, modelID, accountId);
      return {
        id: modelID,
        name: model.name || modelID,
        enabled:
          !isProviderDisabled(provider.id, state, accountId) &&
          !isModelDisabled(provider.id, modelID, state, accountId) &&
          (state.knownModels === undefined || state.knownModels[modelKey] === true),
        contextWindow:
          contextWindowForModel(provider.id, modelID, state, accountId) ??
          runtime.getModel?.(provider.id, modelID)?.contextWindow,
      };
    });
    if (models.length === 0) continue;
    const scope = accountProviderModelKey(provider.id, accountId);
    const orderedModels = sortByPreferredOrder(
      models,
      state.modelOrder[scope] ?? [],
      (model) => model.id,
    );
    rows.push({
      id: provider.id,
      name: provider.name,
      enabled: !isProviderDisabled(provider.id, state, accountId),
      models: orderedModels,
      ...(accountId ? { accountId } : {}),
    });
  }
  const hasAccountRowOrder =
    accountId !== undefined &&
    state.providerOrder.some((key) => key.startsWith(`${accountId}::`));
  return sortByPreferredOrder(
    rows,
    state.providerOrder,
    (provider) =>
      hasAccountRowOrder ? accountProviderModelKey(provider.id, accountId) : provider.id,
  );
}

/**
 * 統合モード用に、同一プロバイダーのアカウント行を 1 行へまとめる。
 * 有効状態は候補プールの和集合として扱い、無効化済みモデルも再有効化できるよう残す。
 */
export function mergeIntegratedProviderRows(
  rows: ProviderModelsRow[],
  state = readProviderModelState(),
): ProviderModelsRow | null {
  const first = rows[0];
  if (!first) return null;
  const hasAccountRowOrder = rows.some(
    (row) =>
      row.accountId !== undefined &&
      state.providerOrder.includes(accountProviderModelKey(row.id, row.accountId)),
  );
  const orderedRows = hasAccountRowOrder
    ? sortByPreferredOrder(
        rows,
        state.providerOrder,
        (row) => accountProviderModelKey(row.id, row.accountId),
      )
    : rows;
  const models = new Map<string, ProviderModelRow>();
  for (const row of orderedRows) {
    for (const model of row.models) {
      const current = models.get(model.id);
      if (!current) {
        models.set(model.id, { ...model });
      } else if (model.enabled) {
        current.enabled = true;
      }
    }
  }
  return {
    id: first.id,
    name: first.name,
    enabled: orderedRows.some((row) => row.enabled),
    models: [...models.values()],
  };
}

export function enabledModelOptionsFromCatalog(
  catalog: ProviderModelsRow[],
): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of catalog) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      if (!model.enabled) continue;
      options.push({
        value: `${provider.id}::${model.id}`,
        label: model.name,
        providerID: provider.id,
        modelID: model.id,
      });
    }
  }
  return options;
}
