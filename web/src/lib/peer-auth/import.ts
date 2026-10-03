import { createRemotePeerCredentialStore } from "@backend-core/peer-auth-remote-store.mjs";
import { normalizePeerUrl, readPeerConfig, writePeerConfig, type PeerConfig } from "@backend-core/peer-auth-config.mjs";
import { parsePeerBearer } from "@backend-core/peer-auth-wire.mjs";
import {
  accountDir,
  ACCOUNT_PROVIDER_IDS,
  createAccount,
  deleteAccount,
  listAccounts,
  resolvePiAgentDir,
  type AccountProviderId,
  type AccountRecord,
} from "@/lib/accounts";

export type PeerImportResult = { status: number; body: unknown };

type Deps = {
  listShared(options: { peerUrl: string; token: string }): Promise<{
    providers: { providerId: string; type: string }[];
    accounts: { accountId: string | null; label: string; providers: string[] }[];
  }>;
  createAccount: typeof createAccount;
  deleteAccount: typeof deleteAccount;
  writeConfig(accountId: string, config: { peerUrl: string; peerAccountId: string | null; providers: string[]; token: string }): Promise<void>;
};

const defaultDeps: Deps = {
  async listShared({ peerUrl, token }) {
    const store = createRemotePeerCredentialStore({ peerUrl, token });
    const [providers, accounts] = await Promise.all([store.list(), store.listAccounts()]);
    return { providers, accounts };
  },
  createAccount,
  deleteAccount,
  async writeConfig(accountId, config) {
    writePeerConfig(accountDir(accountId, await resolvePiAgentDir()), config);
  },
};

const fail = (status: number, error: string): PeerImportResult => ({ status, body: { error } });
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Creates an account whose credentials come from another LCP (docs/plans/peer-auth-share.md).
 * The connection is tested first (a bad URL or token creates nothing), the providers are the ones the
 * peer shares that this LCP can route to, and one local account is created per account the peer
 * offers so this LCP can route across them (integrated mode). The token is stored only in peer.json.
 */
export async function importPeerAccount(input: unknown, deps: Deps = defaultDeps): Promise<PeerImportResult> {
  if (!plain(input) || Object.keys(input).some((key) => !["peerUrl", "token", "label", "providers"].includes(key))) {
    return fail(400, "invalid request");
  }
  const peerUrl = normalizePeerUrl(input.peerUrl);
  const token = input.token;
  if (!peerUrl) return fail(400, "peerUrl is invalid");
  if (typeof token !== "string" || parsePeerBearer(`Bearer ${token}`) !== token) return fail(400, "token is invalid");
  if (input.providers !== undefined && (!Array.isArray(input.providers) || !input.providers.every((id) => typeof id === "string"))) {
    return fail(400, "providers are invalid");
  }
  const base = typeof input.label === "string" ? input.label.trim() : "";
  if (!base) return fail(400, "label is invalid");

  let shared: Awaited<ReturnType<Deps["listShared"]>>;
  try {
    shared = await deps.listShared({ peerUrl, token });
  } catch {
    return fail(502, "could not reach the sharing LCP or the token was rejected");
  }

  const routable = new Set<string>(ACCOUNT_PROVIDER_IDS);
  const requested = input.providers as string[] | undefined;
  const plan = shared.accounts.flatMap((account) => {
    const providers = account.providers.filter(
      (id) => routable.has(id) && (!requested || requested.includes(id)),
    );
    return providers.length ? [{ accountId: account.accountId, label: account.label, providers }] : [];
  });
  if (plan.length === 0) return fail(400, "no shared provider can be used on this LCP");

  const created: AccountRecord[] = [];
  try {
    for (const entry of plan) {
      // The source LCP name is the prefix so an imported account is never mistaken for a local one.
      const label = `${base}:${entry.label}`.slice(0, 100);
      const account = deps.createAccount({ label, providers: entry.providers as AccountProviderId[] });
      created.push(account);
      await deps.writeConfig(account.id, { peerUrl, peerAccountId: entry.accountId, providers: entry.providers, token });
    }
  } catch (error) {
    // Never leave accounts that look local but have no credentials behind.
    for (const account of created) {
      try { deps.deleteAccount(account.id); } catch { /* best effort */ }
    }
    const status = (error as { status?: unknown }).status;
    return status === 400 && error instanceof Error ? fail(400, error.message) : fail(500, "internal error");
  }
  return { status: 201, body: { accounts: created } };
}

export type PeerAccountRow = {
  id: string;
  label: string;
  peerUrl: string;
  providers: string[];
  online: boolean;
};

type ListDeps = {
  listLocalAccounts(): AccountRecord[];
  readPeer(accountId: string): Promise<PeerConfig | null> | PeerConfig | null;
  probe(peerUrl: string, token: string): Promise<boolean>;
};

const defaultListDeps: ListDeps = {
  listLocalAccounts: listAccounts,
  readPeer: async (accountId) => readPeerConfig(accountDir(accountId, await resolvePiAgentDir())),
  async probe(peerUrl, token) {
    try {
      // The same request the credential store makes, so a reachable list means usable credentials.
      await createRemotePeerCredentialStore({ peerUrl, token, timeoutMs: 3_000 }).list();
      return true;
    } catch {
      return false;
    }
  },
};

/** Peer accounts with a reachability probe. Never returns tokens or hashes. */
export async function listPeerAccounts(deps: ListDeps = defaultListDeps): Promise<PeerAccountRow[]> {
  const rows: PeerAccountRow[] = [];
  for (const account of deps.listLocalAccounts()) {
    const peer = await deps.readPeer(account.id);
    if (!peer) continue;
    rows.push({
      id: account.id,
      label: account.label,
      peerUrl: peer.peerUrl,
      providers: account.providers.filter((provider) => peer.providers.includes(provider)),
      online: await deps.probe(peer.peerUrl, peer.token),
    });
  }
  return rows;
}
