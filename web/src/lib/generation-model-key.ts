export const GENERATION_MODEL_SETTING_KEY = "generation-model";
export const DIRECT_GENERATION_PROVIDER_IDS = ["llama-server", "ollama-cloud"] as const;

/** Parse the persisted providerID::modelID form without resolving a provider. */
export function splitGenerationModel(value: unknown): { providerID: string; modelID: string } | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf("::");
  if (separator <= 0 || separator !== value.lastIndexOf("::")) return undefined;
  const providerID = value.slice(0, separator).trim();
  const modelID = value.slice(separator + 2).trim();
  if (!providerID || !modelID || /[\u0000-\u001f\u007f]/.test(providerID + modelID)) return undefined;
  return { providerID, modelID };
}
