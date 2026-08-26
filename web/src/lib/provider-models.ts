import {
  accountProviderModelKey,
  isModelDisabled,
  isProviderDisabled,
  readProviderModelState,
  sortByPreferredOrder,
} from "@/lib/provider-model-state";
import type { ModelOption } from "@/lib/types";

export type ProviderModelRow = {
  id: string;
  name: string;
  enabled: boolean;
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

type RuntimeLike = {
  getProviders(): readonly { id: string; name: string }[];
  getModels(providerId?: string): readonly { id: string; name?: string; provider?: string }[];
  hasConfiguredAuth(providerId: string): boolean;
};

export function buildProviderModelsCatalog(
  runtime: RuntimeLike,
  state = readProviderModelState(),
  accountId?: string,
): ProviderModelsRow[] {
  const rows: ProviderModelsRow[] = [];
  for (const provider of runtime.getProviders()) {
    if (!runtime.hasConfiguredAuth(provider.id)) continue;
    const models = runtime.getModels(provider.id).map((model) => {
      const modelID = model.id;
      return {
        id: modelID,
        name: model.name || modelID,
        enabled:
          !isProviderDisabled(provider.id, state, accountId) &&
          !isModelDisabled(provider.id, modelID, state, accountId),
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
