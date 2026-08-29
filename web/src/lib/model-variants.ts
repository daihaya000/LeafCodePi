/** Provider reasoning metadata shared by Auto routing. */

export type IntelligenceVariant =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "thinking";

export type ModelVariantMeta = {
  variants?: Record<string, { disabled?: boolean } | undefined>;
};

const INTELLIGENCE_KEYS: readonly IntelligenceVariant[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
];

const INTELLIGENCE_KEY_SET = new Set<string>(INTELLIGENCE_KEYS);

export function getIntelligenceVariants(
  model: ModelVariantMeta | undefined,
): IntelligenceVariant[] {
  const variants = model?.variants;
  if (!variants) return [];
  return INTELLIGENCE_KEYS.filter(
    (key) =>
      Object.prototype.hasOwnProperty.call(variants, key) &&
      variants[key]?.disabled !== true,
  );
}

export function isIntelligenceVariant(
  value: unknown,
): value is IntelligenceVariant {
  return typeof value === "string" && INTELLIGENCE_KEY_SET.has(value);
}
