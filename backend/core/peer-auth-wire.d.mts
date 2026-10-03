export type PeerCredential =
  | { type: "api_key"; key: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; expires: number };
export type PeerResolveRequest = { providerId: string; accountId: string | null };
export type PeerResolveResponse = { credential: PeerCredential };
export type PeerList = {
  providers: { providerId: string; type: "api_key" | "oauth" }[];
  accounts: { accountId: string | null; label: string; providers: string[] }[];
};
export type PeerUsageSnapshot = {
  providerId: string;
  providerName: string;
  plan: string | null;
  windows: { id: string; title: string; usedPercent: number; resetsAt: string | null; windowDurationMs: number | null; countsTowardLimit: boolean }[];
  creditsBalance: number | null;
  creditsLabel: string | null;
  creditsEnabled: boolean;
  creditsTitle: string | null;
  creditsUsed: number | null;
  creditsLimit: number | null;
  sourceLabel: string | null;
  updatedAt: string;
  isStale: boolean;
  usageDisplayOnly?: boolean;
  rateLimitResetCreditsAvailable: number | null;
};
export type PeerUsageResponse = { providers: { providerId: string; snapshot: PeerUsageSnapshot | null }[] };
export function parsePeerBearer(header: unknown): string | null;
export function parsePeerResolveRequest(body: unknown): { ok: false } | { ok: true; value: PeerResolveRequest };
export function publicPeerCredential(value: unknown): PeerCredential | null;
export function parsePeerResolveResponse(body: unknown): PeerResolveResponse | null;
export function publicPeerList(value: unknown): PeerList | null;
export function parsePeerUsageRequest(body: unknown): { ok: false } | { ok: true; value: { accountId: string } };
export function publicPeerUsage(value: unknown): PeerUsageResponse | null;
export function publicPeerUsageSnapshot(value: unknown): PeerUsageSnapshot | null;
export const parsePeerUsageResponse: typeof publicPeerUsage;
