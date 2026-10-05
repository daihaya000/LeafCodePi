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
import { checkClaudeResetCredits } from "./providers/anthropic-auto-reset";
import type { UsageScope } from "./types";

// Successful checks are throttled by the provider (5 min); failed checks retry here (1 min).
export const CODEX_RESET_SCHEDULER_INTERVAL_MS = 60_000;
const globals = globalThis as typeof globalThis & {
  __leafcodeCodexResetScheduler?: ReturnType<typeof setInterval>;
  __leafcodeCodexResetTick?: Promise<void>;
};

async function checkAccounts(): Promise<void> {
  const registered = listAccounts();
  const codexEnabled = (account: typeof registered[number]) =>
    accountHasProvider(account, "openai-codex") && account.codexResetAutoConsume !== false;
  const claudeEnabled = (account: typeof registered[number]) =>
    accountHasProvider(account, "anthropic") && account.anthropicResetAutoConsume !== false;
  const accounts = registered.filter((account) => isAccountEnabled(account) && (codexEnabled(account) || claudeEnabled(account)));
  const agentDir = accounts.length > 0 ? await resolvePiAgentDir() : null;
  const scopes: { scope: UsageScope; codex: boolean; claude: boolean }[] = accounts.flatMap((account) => {
    if (readPeerConfig(accountDir(account.id, agentDir!))) return [];
    return [{
      scope: {
        key: `account:${account.id}`,
        kind: "account",
        accountId: account.id,
        accountLabel: account.label,
        authPath: accountAuthPath(account.id, agentDir!),
      },
      codex: codexEnabled(account), claude: claudeEnabled(account),
    }];
  });
  // Keep the legacy Codex fallback; Claude never borrows global/browser cookies.
  if (!registered.some((account) => accountHasProvider(account, "openai-codex"))) {
    scopes.push({ scope: { key: "default", kind: "default", accountId: null, accountLabel: null, authPath: null }, codex: true, claude: false });
  }
  for (const { scope, codex, claude } of scopes) {
    if (codex) {
      try {
        const provider = createOpenaiCodexProvider(scope);
        if (provider.isConfigured()) await provider.fetch();
      } catch {
        console.warn("[codex-auto-reset] account usage unavailable; retry on next check");
      }
    }
    if (claude) {
      try { await checkClaudeResetCredits(scope); }
      catch { console.warn("[claude-auto-reset] account reset credits unavailable; retry on next check"); }
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
