export type JevModelRef = {
  providerId: string;
  modelId: string;
  accountId?: string;
};

export type JevCatalogModel = JevModelRef & {
  providerName: string;
  name: string;
  baseUrl: string;
  accountLabel?: string;
  source: "catalog" | "documented";
  /** Shared provider state from the ordinary model catalog. */
  providerEnabled?: boolean;
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

/** A decision model must never become a Composer/Auto chat candidate. */
export function isJevModel(value: unknown): boolean {
  const model = record(value);
  const architecture = record(model.architecture);
  return (typeof model.id === "string" && /(?:^|\/)jev(?:$|[-_.:])/i.test(model.id)) ||
    hasSystemOneEndpoint(model) ||
    (Array.isArray(architecture.output_modalities) && architecture.output_modalities.includes("decisions"));
}

/** Only explicit System One support or a documented provider establishes compatibility. */
export function supportsJevModel(providerId: string, value: unknown): boolean {
  return hasSystemOneEndpoint(value) ||
    (["typesafe", "openrouter", "commandcode"].includes(providerId) && isJevModel(value));
}
