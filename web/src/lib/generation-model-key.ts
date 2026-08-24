export const GENERATION_MODEL_SETTING_KEY = "generation-model";

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
