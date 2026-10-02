import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { selectNativeJevModel, supportsJevModel, type JevModelRef } from "@/lib/jev-model-catalog";
import { discoverJevModels, registeredJevEndpoint, validJevBaseUrl } from "./jev-model-discovery";

type Runtime = Pick<ModelRuntime, "getProviders" | "getModels" | "checkAuth" | "getAuth"> &
  Partial<Pick<ModelRuntime, "getAllModels">>;

/** Resolve only detected models, using native model-scoped auth when available. */
export async function resolveRegisteredJevConnection(
  runtime: Runtime,
  ref: JevModelRef,
  fetchImpl: typeof fetch = fetch,
): Promise<{ baseUrl: string; model: string; apiKey?: string; headers: Record<string, string> }> {
  const native = selectNativeJevModel(runtime.getAllModels?.(ref.providerId) ?? runtime.getModels(ref.providerId), ref);
  const local = native && supportsJevModel(ref.providerId, native) ? native : undefined;
  // Remote decision models need not be named "jev". Catalog membership, not a name,
  // establishes support; a conflicting native configuration still takes precedence.
  const baseUrl = native ? local && registeredJevEndpoint(runtime, ref)
    : (await discoverJevModels(runtime, { providerIds: [ref.providerId] }, fetchImpl))
      .find((model) => model.modelId === ref.modelId)?.baseUrl;
  if (!baseUrl) throw new Error("選択したJevモデルは未検出です");
  const auth = (local ? await runtime.getAuth(local) : await runtime.getAuth(ref.providerId))?.auth;
  if (!auth) throw new Error("Jevプロバイダーの認証が見つかりません");
  const endpoint = auth.baseUrl === undefined ? baseUrl : validJevBaseUrl(auth.baseUrl);
  if (!endpoint) throw new Error("Jevプロバイダーの接続URLが不正です");
  const headers = Object.fromEntries(Object.entries({ ...local?.headers, ...auth.headers }).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ));
  return { baseUrl: endpoint, model: ref.modelId, apiKey: auth.apiKey, headers };
}
