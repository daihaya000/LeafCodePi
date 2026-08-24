export const GENERATION_MODEL_SETTING_KEY = "generation-model";
export const GENERATION_MODEL_EFFORT_SETTING_KEY = "generation-model-effort";
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

/** Parse the persisted providerID::modelID form without resolving a provider. */
export function splitGenerationModel(value: unknown): { providerID: string; modelID: string } | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf("::");
  if (separator <= 0 || separator !== value.lastIndexOf("::")) return undefined;
  const providerID = value.slice(0, separator).trim();
  const modelID = value.slice(separator + 2).trim();
  if (
    !providerID ||
    !modelID ||
    providerID.length > MAX_PROVIDER_ID_CHARS ||
    modelID.length > MAX_MODEL_ID_CHARS ||
    /[\u0000-\u001f\u007f]/.test(providerID + modelID)
  ) {
    return undefined;
  }
  return { providerID, modelID };
}
