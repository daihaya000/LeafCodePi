/**
 * Approximate public list prices (USD / month). Port of CodexBarWin PlanPricing.
 * Not billed amounts — UI estimates only. Free ($0) returns null.
 */

type Entry = { providerId: string; planKey: string; monthlyUsd: number };

const TABLE: Entry[] = [
  { providerId: "anthropic", planKey: "max 20x", monthlyUsd: 200 },
  { providerId: "anthropic", planKey: "max20x", monthlyUsd: 200 },
  { providerId: "anthropic", planKey: "max_20x", monthlyUsd: 200 },
  { providerId: "anthropic", planKey: "max 5x", monthlyUsd: 100 },
  { providerId: "anthropic", planKey: "max5x", monthlyUsd: 100 },
  { providerId: "anthropic", planKey: "max_5x", monthlyUsd: 100 },
  { providerId: "anthropic", planKey: "max", monthlyUsd: 100 },
  { providerId: "anthropic", planKey: "team", monthlyUsd: 25 },
  { providerId: "anthropic", planKey: "pro", monthlyUsd: 20 },
  { providerId: "anthropic", planKey: "free", monthlyUsd: 0 },

  { providerId: "openai-codex", planKey: "pro", monthlyUsd: 200 },
  { providerId: "openai-codex", planKey: "plus", monthlyUsd: 20 },
  { providerId: "openai-codex", planKey: "team", monthlyUsd: 25 },
  { providerId: "openai-codex", planKey: "business", monthlyUsd: 25 },
  { providerId: "openai-codex", planKey: "free", monthlyUsd: 0 },

  { providerId: "cursor", planKey: "ultra", monthlyUsd: 200 },
  { providerId: "cursor", planKey: "pro+", monthlyUsd: 60 },
  { providerId: "cursor", planKey: "pro plus", monthlyUsd: 60 },
  { providerId: "cursor", planKey: "pro_plus", monthlyUsd: 60 },
  { providerId: "cursor", planKey: "proplus", monthlyUsd: 60 },
  { providerId: "cursor", planKey: "business", monthlyUsd: 40 },
  { providerId: "cursor", planKey: "team", monthlyUsd: 40 },
  { providerId: "cursor", planKey: "pro", monthlyUsd: 20 },
  { providerId: "cursor", planKey: "hobby", monthlyUsd: 0 },
  { providerId: "cursor", planKey: "free", monthlyUsd: 0 },

  { providerId: "opencode-go", planKey: "go", monthlyUsd: 10 },

  { providerId: "commandcode", planKey: "go", monthlyUsd: 1 },
  { providerId: "commandcode", planKey: "pro", monthlyUsd: 15 },
  { providerId: "commandcode", planKey: "provider", monthlyUsd: 15 },
  { providerId: "commandcode", planKey: "max 10x", monthlyUsd: 100 },
  { providerId: "commandcode", planKey: "max 20x", monthlyUsd: 200 },
  { providerId: "commandcode", planKey: "team pro", monthlyUsd: 40 },

  { providerId: "qwen-cloud", planKey: "standard", monthlyUsd: 20 },

  { providerId: "ollama-cloud", planKey: "pro", monthlyUsd: 20 },
  { providerId: "ollama-cloud", planKey: "free", monthlyUsd: 0 },

  { providerId: "synthetic", planKey: "starter", monthlyUsd: 20 },
  { providerId: "synthetic", planKey: "pro", monthlyUsd: 40 },
  { providerId: "synthetic", planKey: "max", monthlyUsd: 60 },
];

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, " ").replace(/-/g, " ");
}

function planMatches(normalizedPlan: string, key: string): boolean {
  if (normalizedPlan === key) return true;
  const planCompact = normalizedPlan.replace(/ /g, "");
  const keyCompact = key.replace(/ /g, "");
  return planCompact === keyCompact;
}

export function tryGetMonthlyUsd(
  providerId: string,
  planLabel: string | null | undefined,
): number | null {
  if (!providerId.trim() || !planLabel?.trim()) return null;
  const normalizedPlan = normalize(planLabel);
  let best: Entry | null = null;
  for (const entry of TABLE) {
    if (entry.providerId.toLowerCase() !== providerId.toLowerCase()) continue;
    const key = normalize(entry.planKey);
    if (!planMatches(normalizedPlan, key)) continue;
    if (!best || key.length > normalize(best.planKey).length) best = entry;
  }
  if (!best) return null;
  return best.monthlyUsd > 0 ? best.monthlyUsd : null;
}
