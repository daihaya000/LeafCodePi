import { parsePeerBearer, parsePeerResolveRequest, parsePeerUsageRequest, publicPeerCredential, publicPeerList, publicPeerUsage } from "./peer-auth-wire.mjs";

// Core of the peer-facing list, resolve and usage endpoints (docs/plans/peer-auth-share.md).
// Pure orchestration: the runtime, credential reads, grants, audit and limiter are injected, so the
// Web routes only adapt Request/Response. Responses never carry refresh tokens or error details.

/** A peer needs this much remaining OAuth validity so its own SDK never tries to refresh. */
export const PEER_MIN_OAUTH_VALIDITY_MS = 10 * 60 * 1000;
const NO_STORE = { "Cache-Control": "no-store" };
const UNAUTHENTICATED_LIMIT_KEY = "peer-auth:unauthenticated";

const reply = (status, body, headers = {}) => ({ status, body, headers: { ...NO_STORE, ...headers } });
const failure = (status, code, headers) => reply(status, { error: code }, headers);
const rateLimited = (taken) => failure(429, "rate-limited", {
  "Retry-After": String(Math.max(1, Math.ceil(taken.retryAfterMs / 1000))),
});

/**
 * @param {{
 *   grants: { verify(token: string): null | { id: string, accountId: string | null, providers: string[] } },
 *   limiter: { take(key: string): { ok: boolean, retryAfterMs: number } },
 *   audit: { record(entry: object): unknown },
 *   readStoredCredential(providerId: string, accountId: string | null): Promise<unknown> | unknown,
 *   getAuth(providerId: string, accountId: string | null, options: { minOAuthValidityMs: number }): Promise<{ auth?: { apiKey?: string } } | undefined>,
 *   listStoredProviders(accountId: string | null): Promise<{ providerId: string, type: string }[]>,
 *   listAccounts(): Promise<{ accountId: string | null, label: string }[]> | { accountId: string | null, label: string }[],
 *   fetchUsage(accountId: string, providerIds: string[]): Promise<{ providerId: string, snapshot: unknown | null }[]>,
 *   now?: () => number,
 * }} deps
 */
export function createPeerAuthService(deps) {
  const now = deps.now ?? (() => Date.now());

  /** Shared gate: invalid credentials share a limit key; valid grants are limited by peer id. */
  const gate = async (authorization, action) => {
    const token = parsePeerBearer(authorization);
    const grant = token ? deps.grants.verify(token) : null;
    if (!grant) {
      // No trusted client IP is available here; group all invalid credentials under one bounded key
      // instead of trusting spoofable forwarded headers. Over-limit attempts are not audited again.
      const taken = deps.limiter.take(UNAUTHENTICATED_LIMIT_KEY);
      if (!taken.ok) return { response: rateLimited(taken) };
      await deps.audit.record({ action: "denied", result: "unauthorized" });
      return { response: failure(401, "unauthorized") };
    }
    const taken = deps.limiter.take(grant.id);
    if (!taken.ok) {
      await deps.audit.record({ peerId: grant.id, action, result: "rate-limited" });
      return { response: rateLimited(taken) };
    }
    return { grant };
  };

  return {
    async list({ authorization }) {
      const checked = await gate(authorization, "list");
      if (checked.response) return checked.response;
      const { grant } = checked;
      try {
        // Every account that holds one of the granted providers is shared; the peer sees them per account.
        const providers = new Map();
        const accounts = [];
        for (const account of await deps.listAccounts()) {
          const stored = (await deps.listStoredProviders(account.accountId))
            .filter((entry) => grant.providers.includes(entry.providerId));
          if (stored.length === 0) continue;
          for (const entry of stored) {
            // The same provider can be OAuth in one account and an API key in another; report the first.
            if (!providers.has(entry.providerId)) providers.set(entry.providerId, entry.type);
          }
          accounts.push({ accountId: account.accountId, label: account.label, providers: stored.map((entry) => entry.providerId) });
        }
        const list = publicPeerList({
          providers: [...providers].map(([providerId, type]) => ({ providerId, type })),
          accounts,
        });
        if (!list) throw new Error("invalid list");
        await deps.audit.record({ peerId: grant.id, action: "list", result: "ok" });
        return reply(200, list);
      } catch {
        await deps.audit.record({ peerId: grant.id, action: "list", result: "error" });
        return failure(503, "unavailable");
      }
    },

    async usage({ authorization, body }) {
      // Usage is a provider-scoped operation, so it shares the existing resolve limiter and audit action.
      const checked = await gate(authorization, "resolve");
      if (checked.response) return checked.response;
      const { grant } = checked;
      const parsed = parsePeerUsageRequest(body);
      if (!parsed.ok) return failure(400, "bad-request");
      const { accountId } = parsed.value;
      try {
        const known = (await deps.listAccounts()).some((account) => account.accountId === accountId);
        if (!known) {
          await deps.audit.record({ peerId: grant.id, action: "resolve", accountId, result: "forbidden" });
          return failure(403, "forbidden");
        }
        const stored = await deps.listStoredProviders(accountId);
        const allowed = grant.providers.filter((providerId) => stored.some((entry) => entry.providerId === providerId));
        const results = await deps.fetchUsage(accountId, allowed);
        const permitted = new Set(allowed);
        const response = publicPeerUsage({
          providers: results.filter((entry) => permitted.has(entry.providerId)),
        });
        if (!response) throw new Error("invalid usage response");
        await deps.audit.record({ peerId: grant.id, action: "resolve", accountId, result: "ok" });
        return reply(200, response);
      } catch {
        await deps.audit.record({ peerId: grant.id, action: "resolve", accountId, result: "error" });
        return failure(503, "unavailable");
      }
    },

    async resolve({ authorization, body }) {
      const checked = await gate(authorization, "resolve");
      if (checked.response) return checked.response;
      const { grant } = checked;
      const parsed = parsePeerResolveRequest(body);
      if (!parsed.ok) return failure(400, "bad-request");
      const { providerId, accountId } = parsed.value;
      if (!grant.providers.includes(providerId)) {
        await deps.audit.record({ peerId: grant.id, action: "resolve", providerId, accountId, result: "forbidden" });
        return failure(403, "forbidden");
      }
      // The peer chooses one of the shared accounts. An account that does not hold this provider is
      // refused before any ambient auth could answer for it.
      try {
        const known = (await deps.listAccounts()).some((account) => account.accountId === accountId);
        const storedForAccount = known ? await deps.listStoredProviders(accountId) : [];
        if (!known) {
          await deps.audit.record({ peerId: grant.id, action: "resolve", providerId, accountId, result: "forbidden" });
          return failure(403, "forbidden");
        }
        // Named accounts must hold the credential themselves; only the default account may fall back
        // to ambient auth (environment/ADC), which would otherwise leak into every account.
        if (accountId !== null && !storedForAccount.some((entry) => entry.providerId === providerId)) {
          await deps.audit.record({ peerId: grant.id, action: "resolve", providerId, accountId, result: "not-found" });
          return failure(404, "not-found");
        }
      } catch {
        await deps.audit.record({ peerId: grant.id, action: "resolve", providerId, accountId, result: "error" });
        return failure(503, "unavailable");
      }
      try {
        let stored = await deps.readStoredCredential(providerId, accountId);
        if (stored?.type === "oauth") {
          // Refresh happens only here: getAuth rotates and persists under the auth file lock.
          await deps.getAuth(providerId, accountId, { minOAuthValidityMs: PEER_MIN_OAUTH_VALIDITY_MS });
          stored = await deps.readStoredCredential(providerId, accountId);
        }
        let credential = publicPeerCredential(stored);
        if (!credential && stored === undefined) {
          const resolved = await deps.getAuth(providerId, accountId, { minOAuthValidityMs: PEER_MIN_OAUTH_VALIDITY_MS });
          const key = resolved?.auth?.apiKey;
          credential = typeof key === "string" ? publicPeerCredential({ type: "api_key", key }) : null;
        }
        if (!credential) {
          await deps.audit.record({ peerId: grant.id, action: "resolve", providerId, accountId, result: "not-found" });
          return failure(404, "not-found");
        }
        if (credential.type === "oauth" && credential.expires <= now()) throw new Error("expired after refresh");
        await deps.audit.record({ peerId: grant.id, action: "resolve", providerId, accountId, result: "ok" });
        return reply(200, { credential });
      } catch {
        await deps.audit.record({ peerId: grant.id, action: "resolve", providerId, accountId, result: "error" });
        return failure(503, "unavailable");
      }
    },
  };
}
