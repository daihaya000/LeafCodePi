import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths";

/**
 * モデルごとの decode 実績。キーは `providerID::modelID`。
 * 平均はトークン加重（tokens / 秒）なので、短い応答が平均を歪めない。
 */
type Row = { tokens: number; ms: number };
type Stats = Record<string, Row>;

/** これ未満のトークン数の応答は実績に入れない（ツール呼び出しだけの短い応答など）。 */
export const MIN_SAMPLE_TOKENS = 16;
const FLUSH_DELAY_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;

/** 未書き込みの差分。flush 時にファイルへ加算するので複数プロセスでも失われない。 */
const pending = new Map<string, Row>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;

function statsPath(): string {
  return join(dataDir(), "model-throughput.json");
}

export function modelThroughputKey(providerID: string, modelID: string): string {
  return `${providerID}::${modelID}`;
}

function validRow(row: unknown): row is Row {
  if (!row || typeof row !== "object") return false;
  const { tokens, ms } = row as Partial<Row>;
  return typeof tokens === "number" && typeof ms === "number" &&
    Number.isFinite(tokens) && Number.isFinite(ms) && tokens > 0 && ms > 0;
}

async function readStats(): Promise<Stats> {
  try {
    const parsed = JSON.parse(await readFile(statsPath(), "utf8")) as unknown;
    // 配列や旧形式の行は捨てる（配列は JSON.stringify で文字列キーが消える）。
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const stats: Stats = {};
    for (const [key, row] of Object.entries(parsed)) if (validRow(row)) stats[key] = row;
    return stats;
  } catch {
    return {};
  }
}

function addRow(target: Map<string, Row> | Stats, key: string, row: Row): void {
  const current = target instanceof Map ? target.get(key) : target[key];
  const next = current ? { tokens: current.tokens + row.tokens, ms: current.ms + row.ms } : { ...row };
  if (target instanceof Map) target.set(key, next);
  else target[key] = next;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** O_EXCL ロックファイルでプロセス間の read-modify-write を直列化する。 */
async function withLock(operation: () => Promise<void>): Promise<boolean> {
  const lock = `${statsPath()}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await (await open(lock, "wx")).close();
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") return false;
      try {
        // 異常終了で残ったロックは一定時間で回収する。
        if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await unlink(lock);
      } catch { /* 他プロセスが解放済み */ }
      if (Date.now() > deadline) return false;
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    await operation();
    return true;
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

/** 未書き込みの実績をファイルへ加算する。失敗時は差分を保持して次回再試行。 */
export function flushModelThroughput(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing) return flushing.then(() => (pending.size > 0 ? flushModelThroughput() : undefined));
  if (pending.size === 0) return Promise.resolve();
  const batch = new Map(pending);
  pending.clear();
  flushing = (async () => {
    let written = false;
    try {
      await mkdir(dataDir(), { recursive: true });
      written = await withLock(async () => {
        const stats = await readStats();
        for (const [key, row] of batch) addRow(stats, key, row);
        const file = statsPath();
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(stats), "utf8");
        await rename(tmp, file);
      });
    } catch {
      written = false;
    }
    if (!written) {
      for (const [key, row] of batch) addRow(pending, key, row);
      scheduleFlush();
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushModelThroughput();
  }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

/**
 * decode 区間（最初〜最後のトークン）の実績を加算する。I/O は遅延・非同期で、
 * 応答処理をブロックしない。
 */
export function recordModelThroughput(
  providerID: string,
  modelID: string,
  sample: { outputTokens: number; decodeMs: number },
): void {
  const { outputTokens, decodeMs } = sample;
  if (!providerID || !modelID) return;
  if (!Number.isFinite(outputTokens) || outputTokens < MIN_SAMPLE_TOKENS) return;
  if (!Number.isFinite(decodeMs) || decodeMs <= 0) return;
  // decodeTokensPerSecond と同じく最初のトークンは TTFT 側に含める（N-1 区間）。
  addRow(pending, modelThroughputKey(providerID, modelID), { tokens: outputTokens - 1, ms: decodeMs });
  scheduleFlush();
}

/** `providerID::modelID` → 平均 tok/s（未書き込み分を含む）。 */
export async function readModelThroughputAverages(): Promise<Map<string, number>> {
  const stats = await readStats();
  for (const [key, row] of pending) addRow(stats, key, row);
  const averages = new Map<string, number>();
  for (const [key, row] of Object.entries(stats)) averages.set(key, (row.tokens * 1000) / row.ms);
  return averages;
}
