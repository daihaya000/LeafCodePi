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

type LlamaPatchableModel = { id?: unknown; input?: unknown; provider?: unknown };
type LlamaPatchableProvider = { id?: unknown; getModels?: () => readonly unknown[] };
type LlamaPatchableRuntime = {
  getModels?: (providerId: string) => readonly unknown[];
  getAvailable?: (...args: unknown[]) => Promise<readonly unknown[]>;
};

/** Pi 内蔵の llama.cpp プロバイダ id。LeafCodePi は表示上 "llama-server" を使う。 */
const LLAMA_PROVIDER_IDS = new Set(["llama.cpp", "llama-server"]);

/** 現在 multimodal と報告されているモデル id。apply のたびに差し替える。 */
let multimodalModelIds = new Set<string>();
/** 我々が image を足したモデル。プロバイダ自身の画像対応は消さない。 */
const visionAddedModels = new WeakSet<object>();
/** ラップ済みの読み取り経路（runtime / provider オブジェクト）。 */
const patchedReaders = new WeakSet<object>();
/** ラップ済みの runtime.getAvailable。 */
const patchedAvailable = new WeakSet<object>();

function patchModelInputs(models: readonly unknown[]): void {
  for (const entry of models) {
    const model = entry as LlamaPatchableModel;
    if (typeof model?.id !== "string") continue;
    // getAvailable は全プロバイダのモデルを返すため、provider が明示されている
    // モデルは llama 系のときだけ対象にする。
    if (typeof model.provider === "string" && !LLAMA_PROVIDER_IDS.has(model.provider)) {
      continue;
    }
    const input = Array.isArray(model.input)
      ? model.input.filter((value): value is string => typeof value === "string")
      : [];
    const has = input.includes("image");
    if (multimodalModelIds.has(model.id)) {
      if (!has) {
        model.input = [...input, "image"];
        visionAddedModels.add(model as object);
      }
      continue;
    }
    // mmproj を外した起動に戻ったら、我々が足した image は取り消す。
    // プロバイダ自身が設定した画像対応（将来 llama.cpp が architecture を
    // 返すようになった場合）は消さない。
    if (has && visionAddedModels.has(model as object)) {
      model.input = input.filter((value) => value !== "image");
      visionAddedModels.delete(model as object);
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
 * モデル一覧の読み取り経路（runtime.getModels と provider.getModels の両方）を
 * ラップし、llama 系プロバイダのモデルへ input "image" を付与する。ラップ方式
 * なので refreshModels がモデル配列を差し替えても補正は維持され、mmproj が
 * 外れた起動に戻れば我々が足した分だけ取り消される。
 *
 * @returns ラップまたは更新した読み取り経路（llama 系プロバイダ）数
 */
export async function applyLlamaVisionToProviderModels(
  runtime: {
    getProviders(): readonly { id: string }[];
    getModels(providerId: string): readonly unknown[];
    getAvailable?(): Promise<readonly unknown[]>;
  },
  imageModelIds: Set<string>,
): Promise<number> {
  multimodalModelIds = imageModelIds;
  const providers = runtime.getProviders();
  let touched = 0;

  // Pi / harness は getAvailable() 経由でモデルを取ることが多い（セッション作成の
  // モデル解決もここを通る）。戻り値をその場で補正する。
  const runtimeLike = runtime as unknown as LlamaPatchableRuntime;
  if (
    typeof runtimeLike.getAvailable === "function" &&
    !patchedAvailable.has(runtimeLike as object)
  ) {
    const originalAvailable = runtimeLike.getAvailable.bind(runtimeLike);
    runtimeLike.getAvailable = async (...args: unknown[]) => {
      const models = await originalAvailable(...args);
      patchModelInputs(models);
      return models;
    };
    patchedAvailable.add(runtimeLike as object);
    touched += 1;
  }

  // Pi が runtime.getModels() 経由で読む場合の補正（LeafCodePi もこの経路を使う）。
  if (typeof runtimeLike.getModels === "function" && !patchedReaders.has(runtimeLike as object)) {
    const original = runtimeLike.getModels.bind(runtimeLike);
    runtimeLike.getModels = (providerId: string) => {
      const models = original(providerId);
      if (LLAMA_PROVIDER_IDS.has(providerId)) patchModelInputs(models);
      return models;
    };
    patchedReaders.add(runtimeLike as object);
    touched += 1;
  }

  // Pi が provider.getModels() を直接読む場合の補正。
  for (const provider of providers) {
    const candidate = provider as unknown as LlamaPatchableProvider;
    if (typeof candidate.id !== "string" || !LLAMA_PROVIDER_IDS.has(candidate.id)) continue;
    if (typeof candidate.getModels === "function" && !patchedReaders.has(candidate as object)) {
      const original = candidate.getModels.bind(candidate);
      candidate.getModels = () => {
        const models = original();
        patchModelInputs(models);
        return models;
      };
      patchedReaders.add(candidate as object);
    }
    touched += 1;
  }

  // 即時反映: ラップ前に読まれたモデル参照（セッションが保持済みの場合など）にも効かせる。
  // getAvailable は引数なしだと全プロバイダ分を取得して高コストなのでここでは呼ばず、
  // 次の取得時にラップ経由で補正する。
  for (const provider of providers) {
    const id = (provider as { id?: unknown }).id;
    if (typeof id !== "string" || !LLAMA_PROVIDER_IDS.has(id)) continue;
    patchModelInputs(runtime.getModels(id));
  }

  return touched;
}
