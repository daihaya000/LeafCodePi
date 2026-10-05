/** Owner-only reset checks: never depend on an open/visible usage widget. */
import {
  accountAuthPath,
  accountDir,
  accountHasProvider,
  isAccountEnabled,
  listAccounts,
  resolvePiAgentDir,
} from "@/lib/accounts";
import { readPeerConfig } from "@backend-core/peer-auth-config.mjs";
import { createOpenaiCodexProvider } from "./providers/openai-codex";
import type { UsageScope } from "./types";

// Successful checks are throttled by the provider (5 min); failed checks retry here (1 min).
export const CODEX_RESET_SCHEDULER_INTERVAL_MS = 60_000;
const globals = globalThis as typeof globalThis & {
  __leafcodeCodexResetScheduler?: ReturnType<typeof setInterval>;
  __leafcodeCodexResetTick?: Promise<void>;
};

async function checkAccounts(): Promise<void> {
  const registered = listAccounts();
  const accounts = registered.filter((account) =>
    isAccountEnabled(account) && accountHasProvider(account, "openai-codex") && account.codexResetAutoConsume !== false,
  );
  const agentDir = accounts.length > 0 ? await resolvePiAgentDir() : null;
  const scopes: UsageScope[] = accounts.flatMap((account) => {
    // Shared credentials are owned by the peer, not this process.
    if (readPeerConfig(accountDir(account.id, agentDir!))) return [];
    return [{
      key: `account:${account.id}`,
      kind: "account",
      accountId: account.id,
      accountLabel: account.label,
      authPath: accountAuthPath(account.id, agentDir!),
    }];
  });
  // Preserve legacy default/CLI authentication only when no Codex account is registered.
  // A paused account must not be silently redeemed through default authentication.
  if (!registered.some((account) => accountHasProvider(account, "openai-codex"))) {
    scopes.push({ key: "default", kind: "default", accountId: null, accountLabel: null, authPath: null });
  }
  for (const scope of scopes) {
    const provider = createOpenaiCodexProvider(scope);
    if (!provider.isConfigured()) continue;
    try {
      // Fresh credentials and no UI aggregate cache; usage also performs OAuth refresh.
      await provider.fetch();
    } catch {
      // Do not log credentials or provider response bodies. One account must not block others.
      console.warn("[codex-auto-reset] account usage unavailable; retry on next check");
    }
  }
}

export function checkCodexResetCredits(): Promise<void> {
  if (globals.__leafcodeCodexResetTick) return globals.__leafcodeCodexResetTick;
  const pending = Promise.resolve().then(checkAccounts).catch(() => {
    console.warn("[codex-auto-reset] scheduler check failed; retry on next check");
  }).finally(() => {
    if (globals.__leafcodeCodexResetTick === pending) delete globals.__leafcodeCodexResetTick;
  });
  globals.__leafcodeCodexResetTick = pending;
  return pending;
}

/** Called by Backend startup, or the local Web runtime owner in development. */
export function ensureCodexResetScheduler(): void {
  if (globals.__leafcodeCodexResetScheduler) return;
  const timer = setInterval(() => { void checkCodexResetCredits(); }, CODEX_RESET_SCHEDULER_INTERVAL_MS);
  timer.unref?.();
  globals.__leafcodeCodexResetScheduler = timer;
  void checkCodexResetCredits();
}
