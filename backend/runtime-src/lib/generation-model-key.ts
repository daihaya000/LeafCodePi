export const GENERATION_MODEL_SETTING_KEY = "generation-model";
export const GENERATION_MODEL_EFFORT_SETTING_KEY = "generation-model-effort";
export const GENERATION_FALLBACK_MODEL_SETTING_KEY = "generation-fallback-model";
export const GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY =
  "generation-fallback-model-effort";
export const GENERATION_MODEL_EFFORTS = [
  "",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type GenerationModelEffort = (typeof GENERATION_MODEL_EFFORTS)[number];

export function isGenerationModelEffort(value: unknown): value is GenerationModelEffort {
  return (
    typeof value === "string" &&
    (GENERATION_MODEL_EFFORTS as readonly string[]).includes(value)
  );
}

const MAX_PROVIDER_ID_CHARS = 100;
const MAX_MODEL_ID_CHARS = 200;

/** Parse a legacy providerID::modelID or accountID::providerID::modelID value. */
export function splitGenerationModel(
  value: unknown,
  knownAccountIds: readonly string[] = [],
): { accountId?: string; providerID: string; modelID: string } | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("::");
  const accountId = parts.length >= 3 && knownAccountIds.includes(parts[0] ?? "") ? parts[0] : undefined;
  const providerID = accountId ? parts[1] : parts[0];
  const modelID = accountId ? parts.slice(2).join("::") : parts.slice(1).join("::");
  if (
    !providerID ||
    !modelID ||
    providerID.length > MAX_PROVIDER_ID_CHARS ||
    modelID.length > MAX_MODEL_ID_CHARS ||
    (accountId && accountId.length > MAX_MODEL_ID_CHARS) ||
    /[\u0000-\u001f\u007f]/.test(`${accountId ?? ""}${providerID}${modelID}`)
  ) {
    return undefined;
  }
  return accountId ? { accountId, providerID, modelID } : { providerID, modelID };
}
