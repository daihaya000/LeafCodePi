import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { hasDecisionsEndpoint, hasSystemOneEndpoint, jevModelApi, selectNativeJevModel, supportsJevModel, type JevModelApi, type JevModelRef } from "@/lib/jev-model-catalog";
import { discoverJevModels, registeredJevEndpoint, validJevBaseUrl } from "./jev-model-discovery";

type Runtime = Pick<ModelRuntime, "getProviders" | "getModels" | "checkAuth" | "getAuth"> &
  Partial<Pick<ModelRuntime, "getAllModels">>;

export type JevModelConnection = {
  baseUrl: string;
  model: string;
  api: JevModelApi;
  apiKey?: string;
  headers?: Record<string, string>;
};

/** Resolve only detected models, using native model-scoped auth when available. */
export async function resolveRegisteredJevConnection(
  runtime: Runtime,
  ref: JevModelRef,
  fetchImpl: typeof fetch = fetch,
): Promise<JevModelConnection> {
  const native = selectNativeJevModel(runtime.getAllModels?.(ref.providerId) ?? runtime.getModels(ref.providerId), ref);
  const needsCatalog = !native || ((native.type === undefined || native.type === "chat") && !hasSystemOneEndpoint(native) &&
    !hasDecisionsEndpoint(native) && ["openrouter", "commandcode"].includes(ref.providerId));
  const catalog = needsCatalog
    ? (await discoverJevModels(runtime, { providerIds: [ref.providerId] }, fetchImpl)).find((model) => model.modelId === ref.modelId)
    : undefined;
  // Discovery can add a wire contract to an SDK chat row, while retaining its URL/auth.
  const local = native && (catalog || supportsJevModel(ref.providerId, native)) ? native : undefined;
  const baseUrl = catalog?.baseUrl ?? (local && registeredJevEndpoint(runtime, ref));
  if (!baseUrl) throw new Error("選択したJevモデルは未検出です");
  const api = catalog ? catalog.api ?? "systemone" : jevModelApi(ref.providerId, local);
  if (!api) throw new Error("選択したJevモデルのAPI形式が不明です");
  const auth = (local ? await runtime.getAuth(local) : await runtime.getAuth(ref.providerId))?.auth;
  if (!auth) throw new Error("Jevプロバイダーの認証が見つかりません");
  const endpoint = auth.baseUrl === undefined ? baseUrl : validJevBaseUrl(auth.baseUrl);
  if (!endpoint) throw new Error("Jevプロバイダーの接続URLが不正です");
  const headers = Object.fromEntries(Object.entries({ ...local?.headers, ...auth.headers }).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ));
  return { baseUrl: endpoint, model: ref.modelId, api, apiKey: auth.apiKey, headers };
}
