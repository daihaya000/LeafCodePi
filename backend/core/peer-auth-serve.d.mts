import type { PeerGrant } from "./peer-auth-grants.mjs";
import type { PeerAuditInput } from "./peer-auth-audit.mjs";

export type PeerServiceResponse = { status: number; body: unknown; headers: Record<string, string> };
export type PeerAuthServiceDeps = {
  grants: { verify(token: string): PeerGrant | null };
  limiter: { take(key: string): { ok: boolean; retryAfterMs: number } };
  audit: { record(entry: PeerAuditInput): unknown };
  readStoredCredential(providerId: string, accountId: string | null): Promise<unknown> | unknown;
  getAuth(
    providerId: string,
    accountId: string | null,
    options: { minOAuthValidityMs: number },
  ): Promise<{ auth?: { apiKey?: string } } | undefined>;
  listStoredProviders(accountId: string | null): Promise<{ providerId: string; type: string }[]>;
  listAccounts():
    | Promise<{ accountId: string | null; label: string }[]>
    | { accountId: string | null; label: string }[];
  now?: () => number;
};
export const PEER_MIN_OAUTH_VALIDITY_MS: number;
export function createPeerAuthService(deps: PeerAuthServiceDeps): {
  list(input: { authorization: string | null | undefined }): Promise<PeerServiceResponse>;
  resolve(input: { authorization: string | null | undefined; body: unknown }): Promise<PeerServiceResponse>;
};
