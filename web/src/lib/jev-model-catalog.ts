export type JevModelRef = {
  providerId: string;
  modelId: string;
  accountId?: string;
};

export type JevModelApi = "systemone" | "decisions";

export type JevCatalogModel = JevModelRef & {
  /** Resolved wire format, not the model's output modality. Legacy rows omit System One. */
  api?: JevModelApi;
  providerName: string;
  name: string;
  baseUrl: string;
  accountLabel?: string;
  source: "catalog" | "documented";
  /** Shared provider state from the ordinary model catalog. */
  providerEnabled?: boolean;
  /** Account routing groups provider cards, but selected models keep their account ids. */
  integrated?: boolean;
};

export function jevModelKey(model: JevModelRef): string {
  return JSON.stringify([model.accountId ?? null, model.providerId, model.modelId]);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function hasSystemOneEndpoint(value: unknown): boolean {
  const model = record(value);
  return model.api === "systemone" || model.api === "typesafe-system-one" ||
    (Array.isArray(model.supported_endpoints) && model.supported_endpoints.some(
      (endpoint) => typeof endpoint === "string" && /^\/(?:v1\/|provider\/v1\/|api\/v1\/)?systemone\/?$/.test(endpoint),
    ));
}

/** Recognize explicit Decisions contracts without guessing from model names or modalities. */
export function hasDecisionsEndpoint(value: unknown): boolean {
  const model = record(value);
  return model.api === "decisions" || model.api === "openai-decisions" ||
    (Array.isArray(model.supported_endpoints) && model.supported_endpoints.some(
      (endpoint) => typeof endpoint === "string" && /^\/(?:v1\/|provider\/v1\/|api\/v1\/)?decisions\/?$/.test(endpoint),
    ));
}

/** Decision-only models must not become Composer/Auto chat candidates. */
export function isJevModel(value: unknown): boolean {
  const model = record(value);
  const architecture = record(model.architecture);
  const hasChatEndpoint = Array.isArray(model.supported_endpoints) && model.supported_endpoints.some(
    (endpoint) => typeof endpoint === "string" && /^\/(?:v1\/|provider\/v1\/|api\/v1\/)?(?:responses|chat\/completions)\/?$/.test(endpoint),
  );
  return (typeof model.id === "string" && /(?:^|\/)jev(?:$|[-_.:])/i.test(model.id)) ||
    hasSystemOneEndpoint(model) || hasDecisionsEndpoint(model) && !hasChatEndpoint ||
    (Array.isArray(architecture.output_modalities) && architecture.output_modalities.includes("decisions"));
}

/** The SDK permits chat/classifier entries with the same id; prefer explicit System One. */
export function selectNativeJevModel<T extends { id: string }>(models: readonly T[], ref: JevModelRef): T | undefined {
  const matching = models.filter((model) => model.id === ref.modelId);
  const supported = matching.filter((model) => supportsJevModel(ref.providerId, model));
  return supported.find(hasSystemOneEndpoint) ?? supported.find(hasDecisionsEndpoint) ?? supported[0] ?? matching[0];
}

export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";

/** Decisions uses API-key OpenAI auth, not the separate Codex subscription. */
export function isOpenAiDecisionsModel(providerId: string, modelId: unknown): boolean {
  return providerId === "openai" && modelId === OPENAI_DECISIONS_MODEL;
}

/** Explicit contracts take precedence; known legacy catalogs keep their System One format. */
export function jevModelApi(providerId: string, value: unknown): JevModelApi | undefined {
  const model = record(value);
  if (model.type !== undefined && model.type !== "chat" && model.type !== "classifier") return undefined;
  if (hasSystemOneEndpoint(model)) return "systemone";
  if (hasDecisionsEndpoint(model)) return "decisions";
  // Other classifier APIs remain incompatible despite their names or output modalities.
  if (model.type === "classifier") return undefined;
  if (isOpenAiDecisionsModel(providerId, model.id)) return "decisions";
  if (["typesafe", "openrouter", "commandcode"].includes(providerId) && isJevModel(value)) return "systemone";
  return undefined;
}

export function supportsJevModel(providerId: string, value: unknown): boolean {
  return jevModelApi(providerId, value) !== undefined;
}
