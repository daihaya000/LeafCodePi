import { TYPESAFE_API_BASE_URL } from "@/lib/pi/typesafe-provider";
import { jevModelKey, type JevCatalogModel, type JevModelRef } from "@/lib/jev-model-catalog";

export const JEV_MODEL_SETTING_KEY = "jev-model";
/** Dispatched on window whenever the Jev model settings or catalog may have changed. */
export const JEV_MODEL_CHANGED_EVENT = "webui:jev-model-changed";

export type JevModelSettings = {
  provider: "typesafe" | "compatible" | "registered";
  registeredModel?: JevModelRef;
  enabledModels?: JevModelRef[];
  typesafeModel: string;
  compatibleBaseUrl: string;
  compatibleModel: string;
  timeoutMs: number;
};

export type JevModelSettingsDto = {
  settings: JevModelSettings;
  hasApiKey: { typesafe: boolean; compatible: boolean };
  models?: JevCatalogModel[];
};

export const DEFAULT_JEV_MODEL_SETTINGS: JevModelSettings = {
  provider: "typesafe",
  typesafeModel: "jev-latest",
  compatibleBaseUrl: "",
  compatibleModel: "jev-latest",
  timeoutMs: 2_000,
};

/** Reject credentials in URLs: secrets belong only in the server-side auth store. */
export function normalizeJevModelSettings(value: unknown): JevModelSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Jevモデル設定が不正です");
  }
  const input = value as Record<string, unknown>;
  if (input.provider !== "typesafe" && input.provider !== "compatible" && input.provider !== "registered") {
    throw new Error("Jevプロバイダーが不正です");
  }
  const readRef = (value: unknown): JevModelRef => {
    const ref = value as Record<string, unknown> | null;
    if (!ref || typeof ref !== "object" || Array.isArray(ref) ||
      [ref.providerId, ref.modelId, ...(ref.accountId === undefined ? [] : [ref.accountId])].some(
        (item) => typeof item !== "string" || !item || item.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(item),
      )) throw new Error("検出済みJevモデルの指定が不正です");
    return {
      providerId: ref.providerId as string, modelId: ref.modelId as string,
      ...(ref.accountId === undefined ? {} : { accountId: ref.accountId as string }),
    };
  };
  const registeredModel = input.registeredModel === undefined ? undefined : readRef(input.registeredModel);
  let enabledModels: JevModelRef[] | undefined;
  if (input.enabledModels !== undefined) {
    if (input.provider !== "registered" || !Array.isArray(input.enabledModels) || input.enabledModels.length < 1 || input.enabledModels.length > 64) {
      throw new Error("有効なJevモデルを1〜64件指定してください");
    }
    enabledModels = input.enabledModels.map(readRef);
    const keys = enabledModels.map(jevModelKey);
    if (new Set(keys).size !== keys.length) throw new Error("Jevモデルが重複しています");
  }
  if (input.provider === "registered" && !registeredModel && !enabledModels) throw new Error("検出済みJevモデルを選択してください");
  for (const key of ["typesafeModel", "compatibleModel"] as const) {
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 256 || /[\s\u0000-\u001f\u007f]/u.test(input[key].trim())) {
      throw new Error("モデルIDは空白を含まない256文字以内で指定してください");
    }
  }
  if (typeof input.compatibleBaseUrl !== "string" || input.compatibleBaseUrl.length > 2048) {
    throw new Error("APIベースURLが不正です");
  }
  let baseUrl = input.compatibleBaseUrl.trim();
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error("APIベースURLが不正です"); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[?#\s\u0000-\u001f\u007f]/u.test(baseUrl)) {
      throw new Error("APIベースURLは認証情報・クエリ・フラグメントを含まないHTTP(S) URLにしてください");
    }
    baseUrl = url.toString().replace(/\/+$/, "");
    if (url.pathname.replace(/\/+$/, "").endsWith("/systemone")) {
      throw new Error("APIベースURLは /systemone を除いて指定してください");
    }
  }
  if (input.provider === "compatible" && !baseUrl) throw new Error("APIベースURLが必要です");
  if (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 120_000) {
    throw new Error("タイムアウトは100〜120000ミリ秒で指定してください");
  }
  return {
    provider: input.provider,
    ...(registeredModel ? { registeredModel } : {}),
    ...(enabledModels ? { enabledModels } : {}),
    typesafeModel: (input.typesafeModel as string).trim(),
    compatibleBaseUrl: baseUrl,
    compatibleModel: (input.compatibleModel as string).trim(),
    timeoutMs: input.timeoutMs,
  };
}

export function enabledJevModelKeys(settings: JevModelSettings, models: JevCatalogModel[]): Set<string> {
  if (settings.enabledModels) return new Set(settings.enabledModels.map(jevModelKey));
  if (settings.provider === "registered") return new Set(settings.registeredModel ? [jevModelKey(settings.registeredModel)] : []);
  const legacy = settings.provider === "typesafe" && models.find((model) => model.providerId === "typesafe" && model.modelId === settings.typesafeModel);
  return new Set(legacy ? [jevModelKey(legacy)] : []);
}

/** True when at least one Jev model can actually be called. */
export function hasUsableJevModel(dto: Pick<JevModelSettingsDto, "settings" | "models">): boolean {
  if (dto.settings.provider === "compatible") return true;
  const models = dto.models ?? [];
  const keys = enabledJevModelKeys(dto.settings, models);
  return models.some((model) => model.providerEnabled !== false && keys.has(jevModelKey(model)));
}

export function jevModelEndpoint(settings: JevModelSettings): { baseUrl: string; model: string } {
  if (settings.provider === "registered") throw new Error("既存プロバイダーの接続先はサーバーで解決してください");
  return settings.provider === "typesafe"
    ? { baseUrl: TYPESAFE_API_BASE_URL, model: settings.typesafeModel }
    : { baseUrl: settings.compatibleBaseUrl, model: settings.compatibleModel };
}
