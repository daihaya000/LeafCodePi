/**
 * CodexBar provider ids are identical to pi/OpenCode-style provider ids.
 * Subscription usage is matched by provider + LeafCode account; shared
 * providers continue to match by provider id only.
 */
import {
  hasLastGoodUsage,
  type CodexBarProvider,
} from "@/lib/codexbar";

function usageKey(providerId: string, accountId?: string | null): string {
  return accountId ? `${accountId}::${providerId}` : providerId;
}

/** Calculate the same account average shown by the integrated provider summary. */
function integratedProviderPercent(
  providerID: string,
  providers: readonly CodexBarProvider[],
): number | null {
  const matching = providers.filter((provider) => provider.id === providerID);
  const accountRows = matching.filter((provider) => provider.accountId);
  const rows = accountRows.length > 0 ? accountRows : matching;
  const values = rows
    .filter(
      (provider) =>
        // ％が表示専用の行（API キー口座の残高から導出した％）は平均に混ぜない
        provider.usageDisplayOnly !== true &&
        hasLastGoodUsage(provider) &&
        provider.usedPercent !== null,
    )
    .map((provider) => provider.usedPercent!);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
    // Integrated options keep the selected candidate's routing usage, while the
    // picker gets the provider's account-average percentage separately.
    if ("routingMode" in option && option.routingMode === "integrated") {
      return {
        ...option,
        codexbarIntegratedUsedPercent: integratedProviderPercent(
          option.providerID,
          providers,
        ),
      };
    }
    if (option.codexbarMaxed === true && option.codexbarStale !== true) {
      return option;
    }
    const provider = byKey.get(usageKey(option.providerID, option.accountId));
    if (!provider) return option;
    // ％が表示専用の行（API キー口座の残高から導出した値など）はピッカーの色や
    // 自動選択のヒントに使わない（表示は設定画面と CodexBar 側で行う）。
    if (provider.usageDisplayOnly === true) return option;
    return {
      ...option,
      codexbarUsedPercent: provider.usedPercent,
      codexbarLimited: provider.limited,
      codexbarMaxed: provider.maxed,
      ...(provider.stale ? { codexbarStale: true } : {}),
    };
  });
}
