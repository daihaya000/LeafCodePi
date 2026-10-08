import { readFileSync } from "node:fs";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { join } from "node:path";
import { createPeerAuditLog, createPeerRateLimiter } from "@backend-core/peer-auth-audit.mjs";
import { createPeerGrantStore } from "@backend-core/peer-auth-grants.mjs";
import { createPeerAuthService, type PeerAuthServiceDeps } from "@backend-core/peer-auth-serve.mjs";
import { accountAuthPath, getAccount, listAccounts, resolvePiAgentDir } from "@/lib/accounts";

/** Provider ids and credential kinds stored in an auth.json. Never returns values. Unreadable = empty. */
export function storedProviderTypes(authPath: string): { providerId: string; type: "api_key" | "oauth" }[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>).flatMap(([providerId, value]) => {
      const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
      return type === "api_key" || type === "oauth" ? [{ providerId, type }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Accounts offered to peers: enabled added accounts only. The default auth.json is never shared:
 * account-routed providers do not use it on this LCP either, and it would otherwise leak to every peer.
 */
export function sharedAccounts(
  accounts: readonly { id: string; label: string; enabled?: boolean }[],
): { accountId: string; label: string }[] {
  return accounts
    .filter((account) => account.enabled !== false)
    .map((account) => ({ accountId: account.id, label: account.label }));
}

async function authPathFor(accountId: string | null): Promise<string | null> {
  const agentDir = await resolvePiAgentDir();
  if (accountId === null) return join(agentDir, "auth.json");
  // A grant can outlive its account; a missing account serves nothing.
  return getAccount(accountId) ? accountAuthPath(accountId, agentDir) : null;
}

/**
 * Connects the peer auth service to the Backend's Pi runtime. The same owner and auth.json file lock
 * serialize Peer leases/refresh with Provider login and account credential updates.
 */
function createDeps(): PeerAuthServiceDeps {
  assertConfigurationOwner();
  return {
    grants: createPeerGrantStore(),
    limiter: createPeerRateLimiter(),
    audit: createPeerAuditLog(),
    async readStoredCredential(providerId, accountId) {
      const path = await authPathFor(accountId);
      if (!path) return undefined;
      const pi = await import("@earendil-works/pi-coding-agent");
      return pi.readStoredCredential(providerId, path);
    },
    async getAuth(providerId, accountId, options) {
      // Imported lazily: the harness pulls in the whole Pi runtime.
      const { getRuntimeFor } = await import("@/lib/pi/harness");
      const runtime = await getRuntimeFor(accountId);
      return runtime?.getAuth(providerId, options);
    },
    async listStoredProviders(accountId) {
      const path = await authPathFor(accountId);
      return path ? storedProviderTypes(path) : [];
    },
    listAccounts: () => sharedAccounts(listAccounts()),
    async fetchUsage(accountId, providerIds) {
      const { fetchNativeProviderUsage } = await import("@/lib/codexbar/orchestrator");
      return fetchNativeProviderUsage(accountId, providerIds);
    },
  };
}

const SERVICE_KEY = Symbol.for("leafcode-pi.peer-auth-service");
type GlobalWithService = typeof globalThis & { [SERVICE_KEY]?: ReturnType<typeof createPeerAuthService> };

/** One service per process so rate-limit windows survive route module reloads. */
export function peerAuthService() {
  assertConfigurationOwner();
  const holder = globalThis as GlobalWithService;
  return (holder[SERVICE_KEY] ??= createPeerAuthService(createDeps()));
}
