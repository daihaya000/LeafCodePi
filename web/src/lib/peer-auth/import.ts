import { createRemotePeerCredentialStore } from "@backend-core/peer-auth-remote-store.mjs";
import { normalizePeerUrl, writePeerConfig } from "@backend-core/peer-auth-config.mjs";
import { parsePeerBearer } from "@shared/peer-auth-wire.mjs";
import {
  accountDir,
  ACCOUNT_PROVIDER_IDS,
  createAccount,
  deleteAccount,
  resolvePiAgentDir,
  type AccountProviderId,
  type AccountRecord,
} from "@/lib/accounts";

export type PeerImportResult = { status: number; body: unknown };

type Deps = {
  listShared(options: { peerUrl: string; token: string }): Promise<{ providerId: string; type: string }[]>;
  createAccount: typeof createAccount;
  deleteAccount: typeof deleteAccount;
  writeConfig(accountId: string, config: { peerUrl: string; peerAccountId: null; providers: string[]; token: string }): Promise<void>;
};

const defaultDeps: Deps = {
  listShared: ({ peerUrl, token }) => createRemotePeerCredentialStore({ peerUrl, token }).list(),
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
 * peer shares that this LCP can route to, and the token is stored only in the account's peer.json.
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

  let shared: { providerId: string; type: string }[];
  try {
    shared = await deps.listShared({ peerUrl, token });
  } catch {
    return fail(502, "could not reach the sharing LCP or the token was rejected");
  }

  const routable = new Set<string>(ACCOUNT_PROVIDER_IDS);
  const available = shared.map((entry) => entry.providerId).filter((id) => routable.has(id));
  const requested = input.providers as string[] | undefined;
  const providers = (requested ? available.filter((id) => requested.includes(id)) : available) as AccountProviderId[];
  if (providers.length === 0) return fail(400, "no shared provider can be used on this LCP");

  let account: AccountRecord;
  try {
    account = deps.createAccount({ label: input.label, providers });
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return status === 400 && error instanceof Error ? fail(400, error.message) : fail(500, "internal error");
  }
  try {
    await deps.writeConfig(account.id, { peerUrl, peerAccountId: null, providers, token });
  } catch {
    // Never leave an account that looks local but has no credentials behind.
    try { deps.deleteAccount(account.id); } catch { /* best effort */ }
    return fail(500, "internal error");
  }
  return { status: 201, body: { account } };
}
