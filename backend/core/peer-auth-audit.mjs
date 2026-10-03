import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./app-paths.mjs";
import { withDirectoryLock } from "./directory-lock.mjs";

// Audit trail and rate limiting for peer auth sharing (docs/plans/peer-auth-share.md).
// Entries hold identifiers and outcomes only: never tokens, hashes or credentials.

const ACTIONS = new Set(["list", "resolve", "denied"]);
const RESULTS = new Set(["ok", "unauthorized", "forbidden", "not-found", "rate-limited", "error"]);
const ID = /^[A-Za-z0-9._-]{1,128}$/;
export const PEER_AUDIT_MAX_LINES = 1000;

export function peerAuthAuditPath() {
  return join(dataDir(), "peer-auth-audit.jsonl");
}

const safeId = (value) => (typeof value === "string" && ID.test(value) ? value : null);

/** @param {{ path?: string, now?: () => Date, maxLines?: number }} [options] */
export function createPeerAuditLog(options = {}) {
  const now = options.now ?? (() => new Date());
  const maxLines = options.maxLines ?? PEER_AUDIT_MAX_LINES;
  const file = () => options.path ?? peerAuthAuditPath();
  let lines = null;

  const countLines = (path) => {
    try { return readFileSync(path, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
  };

  return {
    /** Best effort: an audit write failure must not turn a served request into an error. */
    record({ peerId = null, action, providerId = null, accountId = null, result }) {
      if (!ACTIONS.has(action) || !RESULTS.has(result)) return false;
      const path = file();
      try {
        mkdirSync(dirname(path), { recursive: true });
        const line = JSON.stringify({
          at: now().toISOString(), peerId: safeId(peerId), action, providerId: safeId(providerId),
          accountId: safeId(accountId), result,
        });
        // Append and trim (read -> rewrite -> rename) share one lock so a concurrent process's line
        // cannot fall between the trim's read and its rename. Short wait: auditing is best effort.
        withDirectoryLock({
          lockPath: `${path}.lock`, parentDir: dirname(path), staleMs: 10_000,
          busyMessage: "peer audit log is busy", maxAttempts: 100, waitMs: 5,
        }, () => {
          appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
          lines = (lines ?? countLines(path) - 1) + 1;
          if (lines > maxLines) {
            const kept = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-maxLines);
            const temp = `${path}.tmp`;
            writeFileSync(temp, `${kept.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
            renameSync(temp, path);
            lines = kept.length;
          }
        });
        return true;
      } catch {
        lines = null;
        return false;
      }
    },
    /** Newest last. Malformed lines are skipped. */
    read(limit = 100) {
      try {
        return readFileSync(file(), "utf8").split("\n").filter(Boolean).slice(-Math.max(0, limit)).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
      } catch { return []; }
    },
  };
}

/**
 * Fixed-window limiter keyed by peer id (the App Router exposes no client address).
 * In-memory: a restart resets the windows.
 */
export function createPeerRateLimiter({ limit = 60, windowMs = 60_000, now = () => Date.now(), maxKeys = 1000 } = {}) {
  const windows = new Map();
  return {
    /** @returns {{ ok: boolean, retryAfterMs: number }} */
    take(key) {
      const time = now();
      let entry = windows.get(key);
      if (!entry || time - entry.start >= windowMs) {
        if (!entry && windows.size >= maxKeys) {
          for (const [name, value] of windows) if (time - value.start >= windowMs) windows.delete(name);
          if (windows.size >= maxKeys) return { ok: false, retryAfterMs: windowMs };
        }
        entry = { start: time, count: 0 };
        windows.set(key, entry);
      }
      if (entry.count >= limit) return { ok: false, retryAfterMs: Math.max(0, entry.start + windowMs - time) };
      entry.count += 1;
      return { ok: true, retryAfterMs: 0 };
    },
  };
}
