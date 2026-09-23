import { hasSystemOneEndpoint, isJevModel, jevModelKey, supportsJevModel, type JevCatalogModel, type JevModelRef } from "@/lib/jev-model-catalog";

type Provider = { id: string; name: string; baseUrl?: string };
export type JevDiscoveryRuntime = {
  getProviders(): readonly Provider[];
  getModels(providerId?: string): readonly { id: string; name?: string; baseUrl?: string }[];
  checkAuth(providerId: string): Promise<unknown>;
};

type Scope = { accountId?: string; accountLabel?: string; providerIds?: readonly string[] };
const CATALOG_TTL_MS = 5 * 60_000;
const remoteCatalogs = new Map<string, { expiresAt: number; promise: Promise<unknown[]> }>();

export function clearJevDiscoveryCache(): void {
  remoteCatalogs.clear();
}

function validBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[?#\s]/.test(value)) return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch { return undefined; }
}

function providerBaseUrl(provider: Provider): string | undefined {
  if (provider.id === "commandcode") {
    const root = validBaseUrl(provider.baseUrl ?? "https://api.commandcode.ai");
    return root ? root.endsWith("/provider/v1") ? root : `${root}/provider/v1` : undefined;
  }
  return validBaseUrl(provider.baseUrl ?? (provider.id === "openrouter" ? "https://openrouter.ai/api/v1" : undefined));
}

export function registeredJevEndpoint(runtime: JevDiscoveryRuntime, ref: JevModelRef): string | undefined {
  const provider = runtime.getProviders().find(({ id }) => id === ref.providerId);
  if (!provider) return undefined;
  const local = runtime.getModels(ref.providerId).find((model) => model.id === ref.modelId);
  if (local ? !supportsJevModel(ref.providerId, local) :
      !(["openrouter", "commandcode", "typesafe"].includes(ref.providerId) && isJevModel({ id: ref.modelId }))) return undefined;
  return providerBaseUrl(provider) ?? (local && hasSystemOneEndpoint(local) ? validBaseUrl(local.baseUrl) : undefined);
}

async function remoteModels(url: string, fetchImpl: typeof fetch): Promise<unknown[]> {
  const cached = remoteCatalogs.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const entry = {
    expiresAt: Date.now() + CATALOG_TTL_MS,
    promise: Promise.resolve([] as unknown[]),
  };
  entry.promise = (async () => {
    try {
      // These documented catalogs are public. Do not send any credential during discovery.
      const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("catalog unavailable");
      const body = await response.json();
      if (!Array.isArray(body?.data)) throw new Error("invalid catalog");
      return body.data.slice(0, 1000) as unknown[];
    } catch {
      entry.expiresAt = Date.now() + 30_000;
      return [];
    }
  })();
  remoteCatalogs.set(url, entry);
  return entry.promise;
}

/** Read existing providers without registering decision models in Pi's chat registry. */
export async function discoverJevModels(
  runtime: JevDiscoveryRuntime,
  scope: Scope = {},
  fetchImpl: typeof fetch = fetch,
): Promise<JevCatalogModel[]> {
  const groups = await Promise.all(runtime.getProviders().map(async (provider) => {
    if (scope.providerIds && !scope.providerIds.includes(provider.id)) return [];
    try {
      if (!await runtime.checkAuth(provider.id)) return [];
      const baseUrl = providerBaseUrl(provider);
      const models: unknown[] = [...runtime.getModels(provider.id)];
      if (baseUrl && (provider.id === "openrouter" || provider.id === "commandcode")) {
        const query = provider.id === "openrouter" ? "?output_modalities=decisions&limit=1000" : "";
        models.push(...await remoteModels(`${baseUrl}/models${query}`, fetchImpl));
      }
      const found = new Map<string, JevCatalogModel>();
      for (const value of models) {
        if (!value || typeof value !== "object" || !supportsJevModel(provider.id, value)) continue;
        const model = value as { id?: unknown; name?: unknown; baseUrl?: string };
        if (typeof model.id !== "string" || !model.id.trim() || model.id.length > 256 || /\s/.test(model.id)) continue;
        // Never take credential destinations from remote catalog data. Native custom
        // models may supply a base URL only when they explicitly declare System One.
        const endpoint = baseUrl ?? (hasSystemOneEndpoint(value) ? validBaseUrl(model.baseUrl) : undefined);
        if (!endpoint) continue;
        const row: JevCatalogModel = {
          providerId: provider.id,
          providerName: provider.name,
          modelId: model.id,
          name: typeof model.name === "string" ? model.name.slice(0, 256) : model.id,
          baseUrl: endpoint,
          source: "catalog",
          ...(scope.accountId ? { accountId: scope.accountId, accountLabel: scope.accountLabel } : {}),
        };
        found.set(jevModelKey(row), row);
      }
      // CommandCode documents Jev separately; its public chat catalog currently omits it.
      if (provider.id === "commandcode" && baseUrl && ![...found.values()].some((model) => model.modelId === "typesafe/jev")) {
        const row: JevCatalogModel = {
          providerId: provider.id, providerName: provider.name, modelId: "typesafe/jev", name: "Jev",
          baseUrl, source: "documented",
          ...(scope.accountId ? { accountId: scope.accountId, accountLabel: scope.accountLabel } : {}),
        };
        found.set(jevModelKey(row), row);
      }
      return [...found.values()];
    } catch {
      // One broken provider must not hide the remaining candidates or manual settings.
      return [];
    }
  }));
  return groups.flat();
}
