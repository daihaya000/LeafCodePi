import { TYPESAFE_API_BASE_URL } from "@/lib/pi/typesafe-provider";

export const JEV_MODEL_SETTING_KEY = "jev-model";

export type JevModelSettings = {
  provider: "typesafe" | "compatible";
  typesafeModel: string;
  compatibleBaseUrl: string;
  compatibleModel: string;
  timeoutMs: number;
};

export type JevModelSettingsDto = {
  settings: JevModelSettings;
  hasApiKey: { typesafe: boolean; compatible: boolean };
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
  if (input.provider !== "typesafe" && input.provider !== "compatible") {
    throw new Error("Jevプロバイダーが不正です");
  }
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
    typesafeModel: (input.typesafeModel as string).trim(),
    compatibleBaseUrl: baseUrl,
    compatibleModel: (input.compatibleModel as string).trim(),
    timeoutMs: input.timeoutMs,
  };
}

export function jevModelEndpoint(settings: JevModelSettings): { baseUrl: string; model: string } {
  return settings.provider === "typesafe"
    ? { baseUrl: TYPESAFE_API_BASE_URL, model: settings.typesafeModel }
    : { baseUrl: settings.compatibleBaseUrl, model: settings.compatibleModel };
}
