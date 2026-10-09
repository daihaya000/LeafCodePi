/** Refresh routing usage on the server, independently of browser widget polling. */
import { getCachedUsageAgeMs } from "@/lib/codexbar/cache";
import { fetchNativeUsage } from "@/lib/codexbar/orchestrator";

export const ROUTING_USAGE_FRESH_MS = 5 * 60 * 1000;
export const ROUTING_USAGE_REFRESH_TIMEOUT_MS = 8_000;
export const ROUTING_USAGE_RETRY_COOLDOWN_MS = 30_000;

type UsageFetcher = () => Promise<unknown>;
type RoutingUsageState = {
  inflight: Promise<boolean> | null;
  lastFailedAt: number | null;
};
const STATE_KEY = "__leafcodeRoutingUsageRefresh";
type GlobalState = typeof globalThis & { [STATE_KEY]?: RoutingUsageState };

// Next.js bundles routes separately; share both the cooldown and in-flight work.
function refreshState(): RoutingUsageState {
  const globalRef = globalThis as GlobalState;
  return globalRef[STATE_KEY] ??= { inflight: null, lastFailedAt: null };
}

const defaultFetcher: UsageFetcher = () => fetchNativeUsage({ scope: { kind: "all" } });
let fetcher: UsageFetcher = defaultFetcher;

function isFresh(nowMs: number): boolean {
  // getCachedUsage(ttl) evicts old entries. Do not destroy last-known data when
  // merely probing freshness: routing still needs it if the refresh fails.
  const age = getCachedUsageAgeMs(nowMs);
  return age !== null && age <= ROUTING_USAGE_FRESH_MS;
}

export function ensureFreshRoutingUsage(
  nowMs = Date.now(),
  timeoutMs = ROUTING_USAGE_REFRESH_TIMEOUT_MS,
): Promise<boolean> {
  if (isFresh(nowMs)) return Promise.resolve(true);
  const state = refreshState();
  if (state.inflight) return state.inflight;
  if (state.lastFailedAt !== null && nowMs - state.lastFailedAt < ROUTING_USAGE_RETRY_COOLDOWN_MS) {
    return Promise.resolve(false);
  }
  const operation = refreshUsage(state, timeoutMs).finally(() => {
    if (state.inflight === operation) state.inflight = null;
  });
  state.inflight = operation;
  return operation;
}

async function refreshUsage(state: RoutingUsageState, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The native fetch may also serve a browser request. Bound routing's wait
    // without aborting that shared fetch; a late result may still warm the cache.
    await Promise.race([
      Promise.resolve().then(() => fetcher()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("routing usage refresh timed out")), timeoutMs);
      }),
    ]);
    const ok = isFresh(Date.now());
    // Also back off when no configured provider produced a cacheable result.
    state.lastFailedAt = ok ? null : Date.now();
    return ok;
  } catch {
    state.lastFailedAt = Date.now();
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function __setRoutingUsageFetcherForTests(next: UsageFetcher | null): void {
  fetcher = next ?? defaultFetcher;
  delete (globalThis as GlobalState)[STATE_KEY];
}
