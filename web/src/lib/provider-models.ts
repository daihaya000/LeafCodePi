import {
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
};

type RuntimeLike = {
  getProviders(): readonly { id: string; name: string }[];
  getModels(providerId?: string): readonly { id: string; name?: string; provider?: string }[];
  hasConfiguredAuth(providerId: string): boolean;
};

export function buildProviderModelsCatalog(
  runtime: RuntimeLike,
  state = readProviderModelState(),
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
          !isProviderDisabled(provider.id, state) &&
          !isModelDisabled(provider.id, modelID, state),
      };
    });
    if (models.length === 0) continue;
    const orderedModels = sortByPreferredOrder(
      models,
      state.modelOrder[provider.id] ?? [],
      (model) => model.id,
    );
    rows.push({
      id: provider.id,
      name: provider.name,
      enabled: !isProviderDisabled(provider.id, state),
      models: orderedModels,
    });
  }
  return sortByPreferredOrder(rows, state.providerOrder, (provider) => provider.id);
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
