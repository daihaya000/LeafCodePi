export const TYPESAFE_PROVIDER_ID = "typesafe";
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
export const TYPESAFE_API_BASE_URL = "https://api.typesafe.ai/v1";

type RuntimeLike = {
  getProvider: (id: string) => unknown;
  registerProvider: (id: string, config: Record<string, unknown>) => void;
};

/**
 * TypeSafe は Pi のチャットストリーミング API ではないため、モデルを持たず
 * Settings から TypeSafe API キーを登録・管理する credential provider として登録する。
 */
export function registerTypeSafeProvider(runtime: RuntimeLike): void {
  if (runtime.getProvider(TYPESAFE_PROVIDER_ID)) return;
  runtime.registerProvider(TYPESAFE_PROVIDER_ID, {
    name: "TypeSafe",
    baseUrl: TYPESAFE_API_BASE_URL,
    apiKey: `$${TYPESAFE_API_KEY_ENV}`,
    models: [],
  });
}
