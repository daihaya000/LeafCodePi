import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const GOAL_LOOP_DIR = "goals-loop";

/** Operator-held pauses that expect Resume — must not settle Bot Code outbox yet. */
const GOAL_LOOP_OPERATOR_HOLD_REASONS = new Set(["user", "manual_send"]);

function legacySafeIdPart(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "session";
}

/** Same derivation as the extension's `safeIdPart`; keep the two in step. */
export function safeIdPart(value) {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized === value && sanitized.length <= 120) return sanitized || "session";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${sanitized.slice(0, 100) || "session"}-${digest}`;
}

/**
 * Goal Loop state files: one JSON file per session under the data directory. The
 * cache is keyed by file and validated on mtime/size/inode so another writer's
 * update is noticed immediately, and the entry cap keeps a full task sweep from
 * evicting every entry on each pass.
 */
export class GoalLoopStateStore {
  constructor({ dataDir, clampMaxTurns, clampCooldownSeconds, maxCacheEntries = 2048 }) {
    this.dataDir = dataDir;
    this.clampMaxTurns = clampMaxTurns;
    this.clampCooldownSeconds = clampCooldownSeconds;
    this.maxCacheEntries = maxCacheEntries;
    this.cache = new Map();
  }

  /**
   * cwd is accepted for caller compatibility; state placement is global. The name must match the
   * extension that writes the file (leafcode-goal-loop `goalStateFile`): ids that survive sanitizing
   * unchanged keep their name, any other id gets a digest suffix so distinct ids never share a file.
   */
  stateFile(_cwd, sessionId) {
    return join(this.dataDir(), GOAL_LOOP_DIR, `${safeIdPart(sessionId)}.json`);
  }

  /** The pre-digest file name older builds used for ids that needed sanitizing. */
  legacyStateFile(_cwd, sessionId) {
    return join(this.dataDir(), GOAL_LOOP_DIR, `${legacySafeIdPart(sessionId)}.json`);
  }

  #cache(file, entry) {
    if (this.cache.size >= this.maxCacheEntries && !this.cache.has(file)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(file, entry);
  }

  /** Null for a missing, unreadable, malformed or unrelated state file. */
  read(cwd, sessionId) {
    if (!sessionId) return null;
    const file = this.stateFile(cwd, sessionId);
    const current = this.#readFile(file, sessionId, false);
    if (current) return current;
    // Sessions created before collision-resistant names keep working until their next write migrates them.
    const legacy = this.legacyStateFile(cwd, sessionId);
    return legacy === file ? null : this.#readFile(legacy, sessionId, true);
  }

  /** `requireOwner`: a legacy name may be shared by other ids, so a record naming another session is ignored. */
  #readFile(file, sessionId, requireOwner) {
    try {
      const stat = statSync(file);
      const cached = this.cache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
        // The cache is keyed by file, and a legacy file name can be asked for by several ids.
        return requireOwner && typeof cached.value.sessionId === "string" && cached.value.sessionId !== sessionId ? null : cached.value;
      }
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (!value || typeof value.goal !== "string" || typeof value.status !== "string") {
        this.cache.delete(file);
        return null;
      }
      if (requireOwner && typeof value.sessionId === "string" && value.sessionId !== sessionId) return null;
      const result = {
        ...value,
        maxTurns: this.clampMaxTurns(value.maxTurns),
        cooldownSeconds: this.clampCooldownSeconds(value.cooldownSeconds),
        nextTurnAt: typeof value.nextTurnAt === "string" ? value.nextTurnAt : null,
        unreadableStreak: Math.max(0, Math.trunc(Number(value.unreadableStreak) || 0)),
        // GoalLoopPanel reads progress.at(-1) and turnCount unconditionally, so a
        // partial/hand-edited state file must not crash the panel or render NaN.
        // Mirror the extension's hydrate defaults instead of trusting the file.
        progress: Array.isArray(value.progress) ? value.progress : [],
        turnCount: Math.max(0, Math.trunc(Number(value.turnCount) || 0)),
      };
      this.#cache(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, value: result });
      return result;
    } catch {
      this.cache.delete(file);
      return null;
    }
  }

  /** Drops one entry (tests and writers that replace a file in place). */
  invalidate(file) {
    this.cache.delete(file);
  }

  /** True when the loop is paused for a user/operator hold (not turn_limit / blocked). */
  static isOperatorHold(loop) {
    return loop?.status === "paused" && GOAL_LOOP_OPERATOR_HOLD_REASONS.has(loop.pauseReason ?? "");
  }
}
