/**
 * In-memory failed-login limiter for the WebUI token endpoint. Keyed per client (best effort:
 * first X-Forwarded-For hop, else one shared bucket) so a guessing client is slowed down
 * without letting it lock out others who come from a different address.
 */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 1000;

type Bucket = { failures: number; windowStart: number };
const buckets = new Map<string, Bucket>();

export function loginClientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "shared";
}

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= LOGIN_WINDOW_MS) buckets.delete(key);
  }
  // Still too many distinct keys (spoofed headers): drop the oldest entries.
  while (buckets.size > MAX_TRACKED_CLIENTS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/** Seconds the client must wait, or 0 when another attempt is allowed. */
export function loginRetryAfterSeconds(key: string, now = Date.now()): number {
  const bucket = buckets.get(key);
  if (!bucket) return 0;
  if (now - bucket.windowStart >= LOGIN_WINDOW_MS) {
    buckets.delete(key);
    return 0;
  }
  if (bucket.failures < LOGIN_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((bucket.windowStart + LOGIN_WINDOW_MS - now) / 1000));
}

export function recordLoginFailure(key: string, now = Date.now()): void {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= LOGIN_WINDOW_MS) {
    buckets.set(key, { failures: 1, windowStart: now });
    prune(now);
    return;
  }
  bucket.failures += 1;
}

export function resetLoginFailures(key: string): void {
  buckets.delete(key);
}

export function resetLoginLimiterForTests(): void {
  buckets.clear();
}
