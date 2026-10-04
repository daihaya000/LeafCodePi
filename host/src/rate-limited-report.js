/**
 * Report a recurring failure without flooding the log: the first failure for a key is reported,
 * repeats within `intervalMs` are counted, and the next report after the interval carries the
 * suppressed count. A success clears the key so a later failure is reported at once.
 */
export function createRateLimitedReporter({ report, intervalMs = 60_000, now = () => Date.now() }) {
  const state = new Map();
  return {
    failure(key, error) {
      const at = now();
      const entry = state.get(key);
      if (entry && at - entry.lastReportedAt < intervalMs) {
        entry.suppressed += 1;
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      const suppressed = entry?.suppressed ?? 0;
      report(`${key} failed: ${message}${suppressed > 0 ? ` (${suppressed} similar failures suppressed)` : ""}`);
      state.set(key, { lastReportedAt: at, suppressed: 0 });
      return true;
    },
    success(key) {
      state.delete(key);
    },
  };
}