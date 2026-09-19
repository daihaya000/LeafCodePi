import { llamaServerBaseUrl } from "@/lib/llama-server-settings";

/**
 * llama-server が multimodal（vision projector ロード済み）と報告している
 * モデル id 集合。/v1/models の capabilities が権威で、mmproj 無しでは
 * "multimodal" が含まれないため画像入力を誤って許可しない。
 *
 * 失敗（未起動・タイムアウト・不正応答）は空集合: 画像マークは出ないが、
 * モデル一覧やテキスト利用は止めない。
 */
export async function llamaServerImageModelIds(options?: {
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<Set<string>> {
  const base = (options?.baseUrl ?? llamaServerBaseUrl(process.env.LEAFCODE_PI_LLAMA_PORT))
    .replace(/\/$/, "")
    .replace(/\/v1$/i, "");
  const fetchFn = options?.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${base}/v1/models`, {
      cache: "no-store",
      signal: AbortSignal.timeout(options?.timeoutMs ?? 1_500),
    });
    if (!response.ok) return new Set();
    const body: unknown = await response.json().catch(() => null);
    const models = (body as { models?: unknown })?.models;
    if (!Array.isArray(models)) return new Set();
    const ids = new Set<string>();
    for (const entry of models) {
      const model = entry as { name?: unknown; capabilities?: unknown };
      if (typeof model?.name !== "string" || !model.name) continue;
      const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
      if (capabilities.includes("multimodal")) ids.add(model.name);
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Pi 内蔵の llama.cpp プロバイダは `architecture.input_modalities` を見て
 * モデルの input を決める（provider.js の toPiModel）が、llama.cpp の
 * /v1/models はこのフィールドを返さない。そのため mmproj をロードしても Pi は
 * 「画像非対応」と判定し、送信時に画像がプレースホルダへ置換される
 * （pi-ai transform-messages の downgradeUnsupportedImages）。
 *
 * provider が保持するモデル配列は runtime.getModels() の参照なので、
 * multimodal なモデルへ input "image" を直接足せば以降の判定が通る。
 *
 * @returns 補正したモデル数
 */
export function applyLlamaVisionToProviderModels(
  runtime: {
    getProviders(): readonly { id: string }[];
    getModels(providerId: string): readonly unknown[];
  },
  imageModelIds: Set<string>,
): number {
  if (imageModelIds.size === 0) return 0;
  let patched = 0;
  for (const provider of runtime.getProviders()) {
    const providerModels = runtime.getModels(provider.id);
    if (!Array.isArray(providerModels)) continue;
    for (const entry of providerModels) {
      const model = entry as { id?: unknown; input?: unknown };
      if (typeof model?.id !== "string" || !imageModelIds.has(model.id)) continue;
      const input = Array.isArray(model.input)
        ? model.input.filter((value): value is string => typeof value === "string")
        : [];
      if (input.includes("image")) continue;
      model.input = [...input, "image"];
      patched += 1;
    }
  }
  return patched;
}
