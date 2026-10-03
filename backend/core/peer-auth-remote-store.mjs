import { parsePeerResolveResponse, publicPeerList } from "./peer-auth-wire.mjs";

// B-side CredentialStore for peer auth sharing (docs/plans/peer-auth-share.md).
// It is read-only and never refreshes: the SDK refreshes inside `modify`, so `modify` re-resolves from
// the sharing LCP (A) and never runs the SDK's refresh callback. Secrets stay in memory only.

const RESOLVE_PATH = "/api/peer-auth/resolve";
const LIST_PATH = "/api/peer-auth/list";

function unavailable(status) {
  return new Error(status ? `Peer auth request failed (${status})` : "Peer auth request failed");
}

function peerBase(peerUrl) {
  const url = new URL(peerUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Invalid peer URL");
  return url.origin;
}

/**
 * @param {{
 *   peerUrl: string, token: string, accountId?: string | null,
 *   fetch?: typeof fetch, now?: () => number, timeoutMs?: number,
 *   refreshMarginMs?: number, apiKeyTtlMs?: number,
 * }} options
 */
export function createRemotePeerCredentialStore(options) {
  const base = peerBase(options.peerUrl);
  const { token } = options;
  if (typeof token !== "string" || token.length === 0) throw new Error("Peer token is required");
  const accountId = options.accountId ?? null;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Above the SDK's own five-minute window so a cached token never makes it call `modify`.
  const refreshMarginMs = options.refreshMarginMs ?? 6 * 60_000;
  const apiKeyTtlMs = options.apiKeyTtlMs ?? 5 * 60_000;

  const cache = new Map();
  const inflight = new Map();
  let listCache = null;
  let listInflight = null;

  const request = async (path, init, signal) => {
    const response = await doFetch(`${base}${path}`, {
      ...init,
      // A redirect would carry the bearer token to another origin.
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    return response;
  };

  const toCredential = (credential) => (credential.type === "oauth"
    ? { type: "oauth", access: credential.access, expires: credential.expires, refresh: "" }
    : credential);

  const usable = (entry, margin) => entry && (entry.credential.type === "oauth"
    ? entry.credential.expires - now() > margin
    : entry.fetchedAt + apiKeyTtlMs > now());

  const fetchCredential = async (providerId, signal) => {
    const body = JSON.stringify(accountId === null ? { providerId } : { providerId, accountId });
    let response;
    try {
      response = await request(RESOLVE_PATH, { method: "POST", body }, signal);
    } catch {
      throw unavailable();
    }
    if (response.status === 404) { cache.delete(providerId); return undefined; }
    if (response.status === 401 || response.status === 403) {
      // A revoked or narrowed grant must not be papered over by a cached token.
      cache.delete(providerId);
      throw Object.assign(unavailable(response.status), { rejected: true });
    }
    if (!response.ok) throw unavailable(response.status);
    let parsed = null;
    try { parsed = parsePeerResolveResponse(await response.json()); } catch { /* invalid body */ }
    if (!parsed) throw unavailable();
    const credential = toCredential(parsed.credential);
    cache.set(providerId, { credential, fetchedAt: now() });
    return credential;
  };

  /** Concurrent callers share one request per provider. */
  const resolve = (providerId, signal) => {
    const pending = inflight.get(providerId) ?? fetchCredential(providerId, signal).finally(() => inflight.delete(providerId));
    inflight.set(providerId, pending);
    return pending;
  };

  /** One cached GET of the peer's metadata list, shared by list()/listAccounts()/read(). */
  const fetchList = (signal) => {
    if (listCache && listCache.at + 30_000 > now()) return Promise.resolve(listCache.value);
    if (!listInflight) {
      listInflight = (async () => {
        let response;
        try { response = await request(LIST_PATH, { method: "GET" }, signal); } catch { throw unavailable(); }
        if (!response.ok) throw unavailable(response.status);
        let parsed = null;
        try { parsed = publicPeerList(await response.json()); } catch { /* invalid body */ }
        if (!parsed) throw unavailable();
        listCache = { at: now(), value: parsed };
        return parsed;
      })().finally(() => { listInflight = null; });
    }
    return listInflight;
  };

  /**
   * The SDK probes every provider at runtime creation. Asking the metadata list first keeps a provider
   * the peer does not offer from becoming a failing resolve (which would abort the whole refresh), and
   * avoids a request per unrelated provider.
   */
  const peerOffers = async (providerId, signal) => {
    const list = await fetchList(signal);
    return list.providers.some((entry) => entry.providerId === providerId);
  };

  return {
    async read(providerId, readOptions) {
      const cached = cache.get(providerId);
      if (usable(cached, refreshMarginMs)) return cached.credential;
      try {
        if (!await peerOffers(providerId, readOptions?.signal)) {
          cache.delete(providerId);
          return undefined;
        }
      } catch {
        // The list is unreachable; resolve below reports the real failure (or serves a cached token).
      }
      try {
        return await resolve(providerId, readOptions?.signal);
      } catch (error) {
        // A is unreachable: an unexpired token is still better than failing the request.
        if (!error.rejected && cached && usable(cached, 0)) return cached.credential;
        throw error;
      }
    },

    async list(listOptions) {
      const value = await fetchList(listOptions?.signal);
      return value.providers.map(({ providerId, type }) => ({ providerId, type }));
    },

    /** Accounts the sharing LCP offers, each with the providers it holds. Metadata only. */
    async listAccounts(listOptions) {
      const value = await fetchList(listOptions?.signal);
      return value.accounts.map((account) => ({ ...account, providers: [...account.providers] }));
    },

    /** Never runs `fn`: the SDK's callback would refresh with the peer's token, which only A may do. */
    async modify(providerId, _fn, modifyOptions) {
      cache.delete(providerId);
      return resolve(providerId, modifyOptions?.signal);
    },

    /** Nothing to delete remotely; removing the peer account is a local concern. */
    async delete() {},
  };
}
