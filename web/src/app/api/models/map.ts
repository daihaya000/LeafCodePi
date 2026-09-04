/**
 * CodexBar provider ids are identical to pi/OpenCode-style provider ids.
 * Subscription usage is matched by provider + LeafCode account; shared
 * providers continue to match by provider id only.
 */
import type { CodexBarProvider } from "@/lib/codexbar";

function usageKey(providerId: string, accountId?: string | null): string {
  return accountId ? `${accountId}::${providerId}` : providerId;
}

/** Attach CodexBar usage percent / maxed flag to matching model options. */
export function attachCodexBarUsage<
  T extends {
    providerID: string;
    accountId?: string | null;
    codexbarMaxed?: boolean;
    codexbarStale?: boolean;
  },
>(options: T[], providers: CodexBarProvider[]): T[] {
  if (providers.length === 0) return options;
  const byKey = new Map(
    providers.map((provider) => [usageKey(provider.id, provider.accountId), provider]),
  );
  return options.map((option) => {
    // Integrated options already carry the selected candidate's strict-TTL usage;
    // never overwrite it with CodexBar's aggregate parent row.
    if (
      ("routingMode" in option && option.routingMode === "integrated") ||
      (option.codexbarMaxed === true && option.codexbarStale !== true)
    ) {
      return option;
    }
    const provider = byKey.get(usageKey(option.providerID, option.accountId));
    if (!provider) return option;
    return {
      ...option,
      codexbarUsedPercent: provider.usedPercent,
      codexbarMaxed: provider.maxed,
      ...(provider.stale ? { codexbarStale: true } : {}),
    };
  });
}
