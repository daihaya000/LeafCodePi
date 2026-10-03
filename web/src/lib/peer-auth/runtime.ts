import { readFileSync } from "node:fs";
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

async function authPathFor(accountId: string | null): Promise<string | null> {
  const agentDir = await resolvePiAgentDir();
  if (accountId === null) return join(agentDir, "auth.json");
  // A grant can outlive its account; a missing account serves nothing.
  return getAccount(accountId) ? accountAuthPath(accountId, agentDir) : null;
}

/**
 * Connects the peer auth service to this process's Pi runtime. Provider auth already runs in the Web
 * process (see /api/providers), and the auth.json file lock serializes refresh with the Backend.
 */
function createDeps(): PeerAuthServiceDeps {
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
    listAccounts: () => [
      { accountId: null, label: "default" },
      ...listAccounts().map((account) => ({ accountId: account.id, label: account.label })),
    ],
  };
}

const SERVICE_KEY = Symbol.for("leafcode-pi.peer-auth-service");
type GlobalWithService = typeof globalThis & { [SERVICE_KEY]?: ReturnType<typeof createPeerAuthService> };

/** One service per process so rate-limit windows survive route module reloads. */
export function peerAuthService() {
  const holder = globalThis as GlobalWithService;
  return (holder[SERVICE_KEY] ??= createPeerAuthService(createDeps()));
}
