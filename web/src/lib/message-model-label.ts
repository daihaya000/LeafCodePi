import type { ModelOption, UiMessage } from "@/lib/types";

/** Resolve historical response models to the same names shown in the model picker. */
export function messageModelLabels(options: readonly ModelOption[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const option of options) {
    const key = `${option.providerID}::${option.modelID}`;
    // Prefer the account-free/integrated option for messages without an account ID.
    if (!labels.has(key) || !option.accountId) labels.set(key, option.label);
    if (option.accountId) labels.set(`${option.accountId}::${key}`, option.label);
  }
  return labels;
}

export function messageModelLabel(
  message: Pick<UiMessage, "provider" | "model" | "accountId">,
  labels: ReadonlyMap<string, string>,
): string | undefined {
  if (!message.provider || !message.model) return undefined;
  const key = `${message.provider}::${message.model}`;
  return (message.accountId && labels.get(`${message.accountId}::${key}`)) || labels.get(key) || message.model;
}
