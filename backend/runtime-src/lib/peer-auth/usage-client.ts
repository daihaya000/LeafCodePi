import { createHash } from "node:crypto";
import {
  parsePeerUsageResponse,
  type PeerUsageResponse,
} from "@backend-core/peer-auth-wire.mjs";

export type PeerUsageConfig = {
  peerUrl: string;
  peerAccountId: string | null;
  token: string;
};

const CACHE_MS = 30_000;
const TIMEOUT_MS = 20_000;
const cache = new Map<string, { expiresAt: number; value: PeerUsageResponse }>();
const inflight = new Map<string, Promise<PeerUsageResponse>>();

function cacheKey(peer: PeerUsageConfig): string {
  const tokenHash = createHash("sha256").update(peer.token).digest("hex");
  return `${peer.peerUrl}\n${peer.peerAccountId ?? ""}\n${tokenHash}`;
}

/** Shared batch request for all CodexBar providers attached to this imported account. */
export async function fetchPeerUsage(
  peer: PeerUsageConfig,
  signal?: AbortSignal,
): Promise<PeerUsageResponse> {
  if (!peer.peerAccountId) throw new Error("共有元アカウントがありません。共有アカウントを再インポートしてください");
  const key = cacheKey(peer);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    let response: Response;
    try {
      response = await fetch(`${peer.peerUrl}/api/peer-auth/usage`, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${peer.token}`, "content-type": "application/json" },
        body: JSON.stringify({ accountId: peer.peerAccountId }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
          : AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      throw new Error("共有元の利用状況に接続できません");
    }
    if (!response.ok) throw new Error(`共有元の利用状況を取得できません (${response.status})`);
    let parsed: PeerUsageResponse | null = null;
    try {
      parsed = parsePeerUsageResponse(await response.json());
    } catch {
      // A malformed or oversized-looking response is treated as unavailable, never trusted.
    }
    if (!parsed) throw new Error("共有元の利用状況データが不正です");
    cache.set(key, { expiresAt: Date.now() + CACHE_MS, value: parsed });
    return parsed;
  })().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** Manual refresh bypasses only this short coalescing cache; per-provider cache remains orchestrated above. */
export function clearPeerUsageCache(): void {
  cache.clear();
}
