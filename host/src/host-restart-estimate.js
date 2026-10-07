import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FALLBACK_MS = 5 * 60_000;
const MIN_DURATION_MS = 5_000;
const MAX_DURATION_MS = 15 * 60_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const SAMPLE_LIMIT = 5;
const MAX_LOG_BYTES = 4 * 1024 * 1024;

/** Only completed host replacements count, not WebUI restarts or abandoned requests. */
export function estimateHostRestart(logs, now = Date.now()) {
  const durations = [];
  let requestedAt = null;
  let launches = 0;
  for (const text of logs) {
    for (const line of text.split(/\r?\n/)) {
      const [stamp, source, level, message] = line.split("\t");
      if (source !== "host" || !message) continue;
      const ts = Date.parse(stamp);
      if (!Number.isFinite(ts) || ts > now || now - ts > MAX_AGE_MS) continue;
      if (level === "log" && message === "Host restart requested; spawning replacement…") {
        requestedAt = ts;
        launches = 0;
      } else if (message.startsWith("Host restart failed:") || message.startsWith("LeafCodePi did not become ready")) {
        requestedAt = null;
      } else if (level === "log" && /^LeafCodePi host .* pid=/.test(message)) {
        // A second launch without readiness belongs to recovery, not the original restart.
        if (++launches > 1) requestedAt = null;
      } else if (level === "log" && message === "LeafCodePi is ready" && requestedAt !== null && launches === 1) {
        const duration = ts - requestedAt;
        if (duration >= MIN_DURATION_MS && duration <= MAX_DURATION_MS) {
          durations.push(duration);
        }
        requestedAt = null;
      }
    }
  }
  const recent = durations.slice(-SAMPLE_LIMIT).sort((a, b) => a - b);
  if (recent.length === 0) return { estimateMs: FALLBACK_MS, estimateSamples: 0 };
  const middle = Math.floor(recent.length / 2);
  const median = recent.length % 2 ? recent[middle] : (recent[middle - 1] + recent[middle]) / 2;
  // Median resists a one-off install/slow build; only recent samples follow machine changes.
  return { estimateMs: Math.ceil(median / 1000) * 1000, estimateSamples: recent.length };
}

/** Rotated logs keep history across host replacement and share it with every browser/device. */
export function readHostRestartEstimate(dataDir, now = Date.now()) {
  const logs = ["host.log.2", "host.log.1", "host.log"].map((name) => {
    try {
      const path = join(dataDir, name);
      if (statSync(path).size > MAX_LOG_BYTES) return "";
      return readFileSync(path, "utf8");
    } catch {
      // Missing/unreadable logs must never block a restart.
      return "";
    }
  });
  return estimateHostRestart(logs, now);
}
