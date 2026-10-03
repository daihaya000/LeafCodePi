export type PeerCredential =
  | { type: "api_key"; key: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; expires: number };
export type PeerResolveRequest = { providerId: string; accountId: string | null };
export type PeerResolveResponse = { credential: PeerCredential };
export type PeerList = {
  providers: { providerId: string; type: "api_key" | "oauth" }[];
  accounts: { accountId: string | null; label: string; providers: string[] }[];
};
export function parsePeerBearer(header: unknown): string | null;
export function parsePeerResolveRequest(body: unknown): { ok: false } | { ok: true; value: PeerResolveRequest };
export function publicPeerCredential(value: unknown): PeerCredential | null;
export function parsePeerResolveResponse(body: unknown): PeerResolveResponse | null;
export function publicPeerList(value: unknown): PeerList | null;
