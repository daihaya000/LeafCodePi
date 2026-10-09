import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { dataDir } from "@/lib/paths";
import { STALE_AFTER_MS, type CodexBarProvider, type CodexBarUsage } from "@/lib/codexbar";
import type { ProviderTokenUsage, TokenUsageEstimate } from "./token-usage-types";

const RETENTION_MS = 90 * 86400_000;
const SHARED = new Set(["synthetic", "qwen-cloud", "typesafe"]);
const PROVIDERS = new Set([
  "openai-codex", "anthropic", "commandcode", "opencode-go", "cursor",
  "ollama-cloud", "openrouter", "orcarouter", ...SHARED,
]);
const STORE_KEY = Symbol.for("leafcode-pi.codexbar-token-store/v2");

// Node 22+ built-in. The pinned @types/node 20 does not declare node:sqlite yet.
type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: (string | number | null)[]): { changes: number | bigint };
    get(...values: (string | number | null)[]): unknown;
  };
  close(): void;
};

function canonicalProvider(provider: string): string {
  return provider === "cursor-acp" ? "cursor" : provider;
}

function providerKey(provider: string, accountId?: string | null): string {
  return JSON.stringify([provider, SHARED.has(provider) ? null : accountId ?? null]);
}

type Store = { path: string; db: Database; maintenanceAt: number };
const stores = globalThis as unknown as Record<symbol, Store | undefined>;

/** Release on shutdown/tests or a data-directory change. The global slot also survives BFF hot reload. */
export function closeTokenUsageStore(): void {
  const store = stores[STORE_KEY];
  delete stores[STORE_KEY];
  try { store?.db.close(); } catch { /* telemetry cleanup must never break a response */ }
}

function openStore(): Store {
  const path = join(dataDir(), "codexbar-token-usage.sqlite");
  const cached = stores[STORE_KEY];
  if (cached?.path === path) return cached;
  closeTokenUsageStore();
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => Database;
  };
  mkdirSync(dataDir(), { recursive: true });
  const raw = new DatabaseSync(path);
  try {
    raw.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, at REAL NOT NULL,
        input REAL NOT NULL, output REAL NOT NULL, cacheRead REAL NOT NULL, cacheWrite REAL NOT NULL,
        tokens REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS responses_time ON responses(provider, at);
      CREATE INDEX IF NOT EXISTS responses_retention ON responses(at);
      CREATE TABLE IF NOT EXISTS totals (
        provider TEXT NOT NULL, model TEXT NOT NULL, input REAL NOT NULL, output REAL NOT NULL,
        cacheRead REAL NOT NULL, cacheWrite REAL NOT NULL, tokens REAL NOT NULL,
        responses INTEGER NOT NULL, startedAt REAL NOT NULL, PRIMARY KEY(provider, model)
      );
      CREATE TABLE IF NOT EXISTS observations (
        key TEXT PRIMARY KEY, identity TEXT NOT NULL, anchorAt REAL NOT NULL,
        anchorPercent REAL NOT NULL, anchorTokens REAL NOT NULL,
        latestAt REAL NOT NULL, latestPercent REAL NOT NULL, latestTokens REAL NOT NULL,
        sampledTokens REAL NOT NULL, sampledPercent REAL NOT NULL
      );`);
    const statements = new Map<string, ReturnType<Database["prepare"]>>();
    const db: Database = {
      exec: (sql) => raw.exec(sql),
      prepare(sql) {
        let statement = statements.get(sql);
        if (!statement) {
          statement = raw.prepare(sql);
          statements.set(sql, statement);
        }
        return statement;
      },
      close() { statements.clear(); raw.close(); },
    };
    const store: Store = { path, db, maintenanceAt: 0 };
    stores[STORE_KEY] = store;
    return store;
  } catch (error) {
    try { raw.close(); } catch { /* preserve initialization error */ }
    throw error;
  }
}

/** Short atomic transactions keep Backend/BFF counters consistent without reopening/checkpointing on each token event. */
function withStore<T>(operation: (db: Database) => T, writable = true, busyTimeout = 1000): T | null {
  // Next must never open/migrate a SQLite file, even when a caller asks for a read.
  if (process.env.LEAFCODE_PI_PROCESS_ROLE === "next") return null;
  let store: Store | undefined;
  try {
    store = openStore();
    const { db } = store;
    if (busyTimeout !== 1000) db.exec(`PRAGMA busy_timeout=${busyTimeout}`);
    db.exec(writable ? "BEGIN IMMEDIATE" : "BEGIN");
    const now = Date.now();
    const maintenanceDue = writable && now - store.maintenanceAt > 86400_000;
    if (maintenanceDue) {
      db.prepare("DELETE FROM responses WHERE at < ?").run(now - RETENTION_MS);
      db.prepare("DELETE FROM observations WHERE latestAt < ?").run(now - RETENTION_MS);
    }
    const result = operation(db);
    db.exec("COMMIT");
    if (maintenanceDue) store.maintenanceAt = now;
    return result;
  } catch (error) {
    try { store?.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
    const code = error && typeof error === "object" && "errcode" in error ? error.errcode : null;
    // A busy writer does not invalidate a WAL reader connection.
    if (code !== 5 && code !== 6) closeTokenUsageStore();
    // Telemetry must not interrupt a paid model response or hide provider usage.
    return null;
  } finally {
    if (busyTimeout !== 1000 && store && stores[STORE_KEY] === store) {
      try { store.db.exec("PRAGMA busy_timeout=1000"); } catch { closeTokenUsageStore(); }
    }
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Only authoritative final usage. Never estimate tokens from characters or add reasoning twice. */
export function recordAssistantTokenUsage(
  sessionId: string,
  accountId: string | null | undefined,
  raw: unknown,
  completedAt = Date.now(),
): boolean {
  if (!raw || typeof raw !== "object" || !sessionId) return false;
  const m = raw as Record<string, unknown>;
  if (m.role !== "assistant" || !["stop", "length", "toolUse"].includes(String(m.stopReason))) return false;
  if (typeof m.provider !== "string" || typeof m.model !== "string" || !Number.isFinite(m.timestamp)) return false;
  const provider = canonicalProvider(m.provider);
  if (!PROVIDERS.has(provider) || !m.usage || typeof m.usage !== "object") return false;
  const usage = m.usage as Record<string, unknown>;
  const input = count(usage.input), output = count(usage.output);
  const cacheRead = count(usage.cacheRead), cacheWrite = count(usage.cacheWrite);
  const tokens = count(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || !Number.isFinite(completedAt)) return false;
  const key = providerKey(provider, accountId);
  const responseId = typeof m.responseId === "string" && m.responseId ? m.responseId : null;
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  // Provider response IDs are independent of the requested model alias. Recognize old hashes on upgrades too.
  const id = responseId ? hash([key, responseId]) : hash([key, m.model, [sessionId, m.timestamp]]);
  const legacyId = responseId ? hash([key, m.model, responseId]) : id;
  return withStore((db) => {
    if (legacyId !== id && db.prepare("SELECT id FROM responses WHERE id=?").get(legacyId)) {
      // Bridge an old hash to the alias-independent ID without incrementing its counters again.
      db.prepare("UPDATE OR IGNORE responses SET id=? WHERE id=?").run(id, legacyId);
      return false;
    }
    const inserted = db.prepare("INSERT OR IGNORE INTO responses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, key, m.model as string, completedAt, input, output, cacheRead, cacheWrite, tokens);
    if (!inserted.changes) return false;
    db.prepare(`INSERT INTO totals VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(provider, model) DO UPDATE SET
        input=input+excluded.input, output=output+excluded.output,
        cacheRead=cacheRead+excluded.cacheRead, cacheWrite=cacheWrite+excluded.cacheWrite,
        tokens=tokens+excluded.tokens, responses=responses+1,
        startedAt=MIN(startedAt, excluded.startedAt)`)
      .run(key, m.model as string, input, output, cacheRead, cacheWrite, tokens, completedAt);
    return true;
  }) ?? false;
}

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; tokens: number; responses: number; startedAt: number | null };
type Observation = {
  identity: string; anchorAt: number; anchorPercent: number; anchorTokens: number;
  latestAt: number; latestPercent: number; latestTokens: number; sampledTokens: number; sampledPercent: number;
};
type Window = { id: string; title: string; usedPercent: number | null; resetsAt: string | null; windowMinutes: number | null; countsTowardLimit?: boolean; allowance?: number };

type CalibrationRequest = { needed: boolean };

function estimateWindow(db: Database, p: CodexBarProvider, key: string, w: Window, at: number, now: number, pending?: CalibrationRequest): TokenUsageEstimate {
  const empty: TokenUsageEstimate = { id: w.id, title: w.title, sampledTokens: 0, sampledPercent: 0, tokensPerPercent: null, estimatedRemainingTokens: null, status: "calibrating", validUntil: null };
  if (p.usageDisplayOnly || w.countsTowardLimit === false) return { ...empty, status: "unsupported" };
  const resetAt = w.resetsAt ? Date.parse(w.resetsAt) : null;
  if (w.usedPercent === null || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 ||
      !Number.isFinite(now) || !Number.isFinite(at) || at > now || (resetAt !== null && !Number.isFinite(resetAt))) return { ...empty, status: "invalid" };
  if (p.stale || at < now - STALE_AFTER_MS) return { ...empty, status: "stale" };
  if (resetAt !== null && resetAt <= now) return { ...empty, status: "expired" };
  empty.validUntil = new Date(Math.min(at + STALE_AFTER_MS, resetAt ?? Infinity)).toISOString();

  // Model-specific Claude allowances must not include unrelated models.
  const filter = w.id === "claude-weekly-sonnet" ? "%sonnet%"
    : w.id === "claude-weekly-opus" ? "%opus%"
    : w.id.startsWith("claude-weekly-scoped-") ? null : "%";
  if (filter === null) return { ...empty, status: "unsupported" }; // Arbitrary model scopes cannot be inferred safely from a label.
  const observationKey = JSON.stringify([key, w.id]);
  const identity = JSON.stringify([2, p.plan, w.resetsAt, w.windowMinutes, filter, w.allowance ?? null]);
  let row = db.prepare("SELECT * FROM observations WHERE key=?").get(observationKey) as Observation | undefined;
  if (row && at < row.latestAt) return { ...empty, status: "stale" }; // Out-of-order fetch completion cannot rewind calibration.
  // A repeated upstream cache value cannot reveal a new rate. Avoid range SUMs and WAL writes entirely.
  if (row && at === row.latestAt && row.identity === identity && w.usedPercent === row.latestPercent) {
    return calibratedEstimate(empty, row, w.usedPercent);
  }
  if (pending) {
    pending.needed = true;
    return empty; // A changed snapshot needs a separate short writer transaction.
  }
  const total = db.prepare("SELECT COALESCE(SUM(tokens), 0) AS tokens FROM totals WHERE provider=? AND model LIKE ?")
    .get(key, filter) as { tokens: number };
  const later = db.prepare("SELECT COALESCE(SUM(tokens), 0) AS tokens FROM responses WHERE provider=? AND model LIKE ? AND at > ?")
    .get(key, filter, at) as { tokens: number };
  const tokens = total.tokens - later.tokens;
  if (!row || row.identity !== identity || row.anchorAt < now - RETENTION_MS ||
      w.usedPercent < row.latestPercent || tokens < row.latestTokens ||
      (at > row.latestAt && w.usedPercent > row.latestPercent && tokens - row.anchorTokens <= row.sampledTokens)) {
    row = { identity, anchorAt: at, anchorPercent: w.usedPercent, anchorTokens: tokens,
      latestAt: at, latestPercent: w.usedPercent, latestTokens: tokens, sampledTokens: 0, sampledPercent: 0 };
  } else if (at > row.latestAt) {
    const deltaPercent = w.usedPercent - row.anchorPercent;
    const deltaTokens = tokens - row.anchorTokens;
    // Require at least one percentage point, accumulating tokens through rounded/lagged unchanged polls.
    // Freeze at saturation: additional tokens at 100% do not reveal additional quota.
    if (deltaPercent >= 1 && deltaTokens > 0 && w.usedPercent > row.latestPercent && row.latestPercent < 100) {
      row.sampledTokens = deltaTokens;
      row.sampledPercent = deltaPercent;
    }
    row.latestAt = at;
    row.latestPercent = w.usedPercent;
    row.latestTokens = tokens;
  }
  db.prepare(`INSERT OR REPLACE INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(observationKey, row.identity, row.anchorAt, row.anchorPercent, row.anchorTokens,
      row.latestAt, row.latestPercent, row.latestTokens, row.sampledTokens, row.sampledPercent);
  return calibratedEstimate(empty, row, w.usedPercent);
}

function calibratedEstimate(empty: TokenUsageEstimate, row: Observation, percent: number): TokenUsageEstimate {
  const rate = row.sampledPercent >= 1 ? row.sampledTokens / row.sampledPercent : null;
  return { ...empty, status: rate === null ? "calibrating" : "ready", sampledTokens: row.sampledTokens, sampledPercent: row.sampledPercent,
    tokensPerPercent: rate, estimatedRemainingTokens: rate === null ? null : Math.max(0, 100 - percent) * rate };
}

/** Decorate outside the upstream cache, so cached percentages never absorb later response tokens. */
export function attachTokenUsage(usage: CodexBarUsage, now = Date.now()): CodexBarUsage {
  if (usage.providers.length === 0) return usage;
  const decorate = (db: Database, pending?: CalibrationRequest) => usage.providers.map((p) => {
    if (!PROVIDERS.has(p.id)) return p;
    const key = providerKey(p.id, p.accountId);
    const totals = db.prepare(`SELECT COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output,
      COALESCE(SUM(cacheRead), 0) AS cacheRead, COALESCE(SUM(cacheWrite), 0) AS cacheWrite,
      COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(responses), 0) AS responses, MIN(startedAt) AS startedAt
      FROM totals WHERE provider=?`).get(key) as Totals;
    const at = p.updatedAt ? Date.parse(p.updatedAt) : NaN;
    const windows: Window[] = p.windows.length > 0 ? [...p.windows] :
      p.usedPercent !== null && !p.credits ? [{ id: "provider", title: "利用枠", usedPercent: p.usedPercent, resetsAt: p.resetsAt, windowMinutes: null }] : [];
    const credits = p.credits;
    if (credits?.used !== null && credits?.used !== undefined && credits.limit !== null && credits.limit > 0) {
      windows.push({ id: "credits", title: credits.title ?? "利用クレジット", usedPercent: credits.used / credits.limit * 100, resetsAt: p.resetsAt, windowMinutes: null, allowance: credits.limit });
    }
    const tokenUsage: ProviderTokenUsage = { input: totals.input, output: totals.output,
      cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, totalTokens: totals.tokens,
      responses: totals.responses, startedAt: totals.startedAt === null ? null : new Date(totals.startedAt).toISOString(),
      windows: windows.map((w) => estimateWindow(db, p, key, w, at, now, pending)) };
    return { ...p, tokenUsage };
  });
  const pending: CalibrationRequest = { needed: false };
  // WAL readers do not contend with Backend writes, even for stale/invalid snapshots.
  const providers = withStore((db) => decorate(db, pending), false);
  if (!providers) return usage;
  if (!pending.needed) return { ...usage, providers };
  // Busy calibration is optional: keep the measured totals and retry on the next poll.
  const calibrated = withStore((db) => decorate(db), true, 25);
  return { ...usage, providers: calibrated ?? providers };
}
