export type PeerAuditEntry = {
  at: string;
  peerId: string | null;
  action: "list" | "resolve" | "denied";
  providerId: string | null;
  accountId: string | null;
  result: "ok" | "unauthorized" | "forbidden" | "not-found" | "rate-limited" | "error";
};
export type PeerAuditInput = {
  peerId?: string | null;
  action: PeerAuditEntry["action"];
  providerId?: string | null;
  accountId?: string | null;
  result: PeerAuditEntry["result"];
};
export const PEER_AUDIT_MAX_LINES: number;
export function peerAuthAuditPath(): string;
export function createPeerAuditLog(options?: { path?: string; now?: () => Date; maxLines?: number }): {
  record(entry: PeerAuditInput): boolean;
  read(limit?: number): PeerAuditEntry[];
};
export function createPeerRateLimiter(options?: { limit?: number; windowMs?: number; now?: () => number; maxKeys?: number }): {
  take(key: string): { ok: boolean; retryAfterMs: number };
};
