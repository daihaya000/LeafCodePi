import { createRemotePeerCredentialStore } from "@backend-core/peer-auth-remote-store.mjs";
import { readPeerConfig } from "@backend-core/peer-auth-config.mjs";
import { accountAuthPath, accountDir, accountModelsStorePath } from "@/lib/accounts";

const REPAIR_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000];

type RepairableRuntime = {
  hasConfiguredAuth(providerId: string): boolean;
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
};

/**
 * The SDK checks credentials once when a runtime is created and never again on its own. A peer account
 * created while the sharing LCP was slow, offline or rate limiting keeps an empty snapshot, so its models
 * stay hidden. Retry that check with backoff until the shared providers are configured.
 */
export function watchPeerAvailability(
  runtime: RepairableRuntime,
  id: string,
  agentDir: string,
  onRepaired: () => void,
  delays: readonly number[] = REPAIR_DELAYS_MS,
): void {
  const peer = readPeerConfig(accountDir(id, agentDir));
  // Never let the repair loop break runtime creation (test doubles and older runtimes lack these).
  if (!peer || typeof runtime.hasConfiguredAuth !== "function" || typeof runtime.refresh !== "function") return;
  const ready = () => {
    try {
      return peer.providers.every((providerId) => runtime.hasConfiguredAuth(providerId));
    } catch {
      return true;
    }
  };
  let attempt = 0;
  const schedule = () => {
    if (ready() || attempt >= delays.length) return;
    const timer = setTimeout(() => {
      attempt += 1;
      void runtime.refresh({ allowNetwork: false }).catch(() => undefined).then(() => {
        if (ready()) onRepaired();
        else schedule();
      });
    }, delays[attempt]);
    (timer as { unref?: () => void }).unref?.();
  };
  schedule();
}

/** Whether this account takes its credentials from another LCP (valid `peer.json`). */
export function isPeerAccount(id: string, agentDir: string): boolean {
  return readPeerConfig(accountDir(id, agentDir)) !== null;
}

/**
 * Options for an account's ModelRuntime. An account with a valid `peer.json` takes its credentials from
 * another LCP through a read-only, in-memory store and has no auth.json of its own; every other account
 * keeps its file-backed auth. (docs/plans/peer-auth-share.md)
 */
export function accountRuntimeOptions(id: string, agentDir: string) {
  const common = {
    modelsStorePath: accountModelsStorePath(id, agentDir),
    allowModelNetwork: true,
    modelRefreshTimeoutMs: 8_000,
  };
  const peer = readPeerConfig(accountDir(id, agentDir));
  if (!peer) return { authPath: accountAuthPath(id, agentDir), ...common };
  return {
    credentials: createRemotePeerCredentialStore({ peerUrl: peer.peerUrl, token: peer.token, accountId: peer.peerAccountId }),
    ...common,
  };
}
