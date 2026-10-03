import { parsePeerResolveResponse, publicPeerList } from "./peer-auth-wire.mjs";

// B-side CredentialStore for peer auth sharing (docs/plans/peer-auth-share.md).
// It is read-only and never refreshes: the SDK refreshes inside `modify`, so `modify` re-resolves from
// the sharing LCP (A) and never runs the SDK's refresh callback. Secrets stay in memory only.

const RESOLVE_PATH = "/api/peer-auth/resolve";
const LIST_PATH = "/api/peer-auth/list";
const LIST_TTL_MS = 30_000;

function unavailable(status) {
  return new Error(status ? `Peer auth request failed (${status})` : "Peer auth request failed");
}

function peerBase(peerUrl) {
  const url = new URL(peerUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Invalid peer URL");
  return url.origin;
}

/**
 * Caches shared by every store that talks to the same peer with the same token. One import creates a
 * local account per account of the sharing LCP, and runtimes are recreated over time; sharing the
 * metadata list and resolved credentials keeps that from multiplying requests (and hitting A's rate limit).
 */
export function createPeerCacheRegistry() {
  const peers = new Map();
  return {
    get(key) {
      let peer = peers.get(key);
      if (!peer) {
        peer = { list: null, listInflight: null, credentials: new Map(), inflight: new Map() };
        peers.set(key, peer);
      }
      return peer;
    },
  };
}

const defaultRegistry = createPeerCacheRegistry();

/**
 * @param {{
 *   peerUrl: string, token: string, accountId?: string | null,
 *   fetch?: typeof fetch, now?: () => number, timeoutMs?: number,
 *   refreshMarginMs?: number, apiKeyTtlMs?: number,
 *   registry?: ReturnType<typeof createPeerCacheRegistry>,
 * }} options
 */
export function createRemotePeerCredentialStore(options) {
  const base = peerBase(options.peerUrl);
  const { token } = options;
  if (typeof token !== "string" || token.length === 0) throw new Error("Peer token is required");
  const accountId = options.accountId ?? null;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  // A may have to start the account runtime (and refresh OAuth) before it can answer.
  const timeoutMs = options.timeoutMs ?? 20_000;
  // Above the SDK's own five-minute window so a cached token never makes it call `modify`.
  const refreshMarginMs = options.refreshMarginMs ?? 6 * 60_000;
  const apiKeyTtlMs = options.apiKeyTtlMs ?? 5 * 60_000;
  const shared = (options.registry ?? defaultRegistry).get(`${base}\n${token}`);
  const credentialKey = (providerId) => `${accountId ?? ""}\n${providerId}`;

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
    const key = credentialKey(providerId);
    const body = JSON.stringify(accountId === null ? { providerId } : { providerId, accountId });
    let response;
    try {
      response = await request(RESOLVE_PATH, { method: "POST", body }, signal);
    } catch {
      throw unavailable();
    }
    if (response.status === 404) { shared.credentials.delete(key); return undefined; }
    if (response.status === 401 || response.status === 403) {
      // A revoked or narrowed grant must not be papered over by a cached token.
      shared.credentials.delete(key);
      throw Object.assign(unavailable(response.status), { rejected: true });
    }
    if (!response.ok) throw unavailable(response.status);
    let parsed = null;
    try { parsed = parsePeerResolveResponse(await response.json()); } catch { /* invalid body */ }
    if (!parsed) throw unavailable();
    const credential = toCredential(parsed.credential);
    shared.credentials.set(key, { credential, fetchedAt: now() });
    return credential;
  };

  /** Concurrent callers share one request per account and provider. */
  const resolve = (providerId, signal) => {
    const key = credentialKey(providerId);
    const pending = shared.inflight.get(key) ?? fetchCredential(providerId, signal).finally(() => shared.inflight.delete(key));
    shared.inflight.set(key, pending);
    return pending;
  };

  /** One cached GET of the peer's metadata list; a stale copy is kept for when A is briefly unreachable. */
  const fetchList = (signal) => {
    if (shared.list && shared.list.at + LIST_TTL_MS > now()) return Promise.resolve(shared.list.value);
    if (!shared.listInflight) {
      shared.listInflight = (async () => {
        let response;
        try { response = await request(LIST_PATH, { method: "GET" }, signal); } catch { throw unavailable(); }
        if (!response.ok) throw unavailable(response.status);
        let parsed = null;
        try { parsed = publicPeerList(await response.json()); } catch { /* invalid body */ }
        if (!parsed) throw unavailable();
        shared.list = { at: now(), value: parsed };
        return parsed;
      })().finally(() => { shared.listInflight = null; });
    }
    return shared.listInflight;
  };

  /**
   * The SDK probes every provider at runtime creation. Asking the metadata list first keeps a provider
   * this account is not offered from becoming a failing resolve (which would abort the whole refresh).
   * Offers are per account: a provider another account of A holds is not this account's to use.
   */
  const peerOffers = async (providerId, signal) => {
    let list;
    try {
      list = await fetchList(signal);
    } catch (error) {
      if (!shared.list) throw error;
      list = shared.list.value;
    }
    const account = list.accounts.find((entry) => entry.accountId === accountId);
    return account ? account.providers.includes(providerId) : false;
  };

  return {
    async read(providerId, readOptions) {
      const key = credentialKey(providerId);
      const cached = shared.credentials.get(key);
      if (usable(cached, refreshMarginMs)) return cached.credential;
      try {
        if (!await peerOffers(providerId, readOptions?.signal)) {
          shared.credentials.delete(key);
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
      shared.credentials.delete(credentialKey(providerId));
      return resolve(providerId, modifyOptions?.signal);
    },

    /** Nothing to delete remotely; removing the peer account is a local concern. */
    async delete() {},
  };
}
