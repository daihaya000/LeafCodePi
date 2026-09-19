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

type LlamaPatchableModel = { id?: unknown; input?: unknown };
type LlamaPatchableProvider = {
  id?: unknown;
  getModels?: () => readonly unknown[];
};
type LlamaPatchState = {
  ids: Set<string>;
  /** このセッションで我々が image を足したモデル。ネイティブの画像対応は消さない。 */
  added: WeakSet<object>;
  original: () => readonly unknown[];
};

/** Pi 内蔵の llama.cpp プロバイダ id。LeafCodePi は表示上 "llama-server" を使う。 */
const LLAMA_PROVIDER_IDS = new Set(["llama.cpp", "llama-server"]);

/** 登録済みの getModels ラップ。refreshModels がモデル配列を差し替えても補正を維持する。 */
const patchedProviders = new WeakMap<object, LlamaPatchState>();

function patchModelInputs(models: readonly unknown[], state: LlamaPatchState): void {
  for (const entry of models) {
    const model = entry as LlamaPatchableModel;
    if (typeof model?.id !== "string") continue;
    const input = Array.isArray(model.input)
      ? model.input.filter((value): value is string => typeof value === "string")
      : [];
    const has = input.includes("image");
    if (state.ids.has(model.id)) {
      if (!has) {
        model.input = [...input, "image"];
        state.added.add(model as object);
      }
      continue;
    }
    // mmproj を外した起動に戻ったら、我々が足した image は取り消す。
    // プロバイダ自身が設定した画像対応（将来 llama.cpp が architecture を
    // 返すようになった場合）は消さない。
    if (has && state.added.has(model as object)) {
      model.input = input.filter((value) => value !== "image");
      state.added.delete(model as object);
    }
  }
}

/**
 * Pi 内蔵の llama.cpp プロバイダは `architecture.input_modalities` を見て
 * モデルの input を決める（provider.js の toPiModel）が、llama.cpp の
 * /v1/models はこのフィールドを返さない。そのため mmproj をロードしても Pi は
 * 「画像非対応」と判定し、送信時に画像がプレースホルダへ置換される
 * （pi-ai transform-messages の downgradeUnsupportedImages）。
 *
 * provider の getModels をラップし、multimodal なモデルへ input "image" を
 * 付与する（refreshModels で配列が差し替わっても維持され、mmproj が外れたら
 * 元に戻る）。
 *
 * @returns ラップまたは更新した llama 系プロバイダ数
 */
export function applyLlamaVisionToProviderModels(
  runtime: {
    getProviders(): readonly { id: string }[];
    getModels(providerId: string): readonly unknown[];
  },
  imageModelIds: Set<string>,
): number {
  let touched = 0;
  for (const provider of runtime.getProviders()) {
    const candidate = provider as unknown as LlamaPatchableProvider;
    if (typeof candidate.id !== "string" || !LLAMA_PROVIDER_IDS.has(candidate.id)) continue;
    if (typeof candidate.getModels !== "function") continue;
    let state = patchedProviders.get(candidate as object);
    if (!state) {
      const original = candidate.getModels.bind(candidate);
      state = { ids: imageModelIds, added: new WeakSet(), original };
      patchedProviders.set(candidate as object, state);
      candidate.getModels = () => {
        const models = state!.original();
        patchModelInputs(models, state!);
        return models;
      };
    } else {
      state.ids = imageModelIds;
    }
    patchModelInputs(state.original(), state);
    touched += 1;
  }
  return touched;
}
