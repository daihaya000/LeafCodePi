/**
 * CodexBar provider ids are identical to pi/OpenCode-style provider ids, so
 * model options attach rate-limit info by direct id match. Providers without
 * usage data (local LLMs etc.) simply have no rate-limit info.
 */
import type { CodexBarProvider } from "@/lib/codexbar";

/** Attach CodexBar usage percent / maxed flag to matching model options. */
export function attachCodexBarUsage<T extends { providerID: string }>(
  options: T[],
  providers: CodexBarProvider[],
): T[] {
  if (providers.length === 0) return options;
  const byId = new Map(providers.map((p) => [p.id, p]));
  return options.map((option) => {
    const p = byId.get(option.providerID);
    if (!p) return option;
    return {
      ...option,
      codexbarUsedPercent: p.usedPercent,
      codexbarMaxed: p.maxed,
    };
  });
}
