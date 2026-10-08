import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths";
import { getSetting } from "./pi/web-settings";
import { MAX_MODEL_THROUGHPUT_WINDOW, MODEL_THROUGHPUT_WINDOW_SETTING_KEY, parseModelThroughputWindow } from "./model-throughput-settings";

/**
 * モデルごとの decode 実績。キーは `providerID::modelID`。
 * 直近N件の tokens / 秒で平均。設定を増やしたときに使えるよう最大1000件を保持する。
 */
type Sample = { id: string; at: number; tokens: number; ms: number };
type Stats = Record<string, Sample[]>;

/** これ未満のトークン数の応答は実績に入れない（ツール呼び出しだけの短い応答など）。 */
export const MIN_SAMPLE_TOKENS = 16;
const FLUSH_DELAY_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;

/** 未書き込みの応答。flush 時にロック下でマージするので複数プロセスでも失われない。 */
const pending = new Map<string, Sample[]>();
let activeBatch: Map<string, Sample[]> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;

function statsPath(): string {
  return join(dataDir(), "model-throughput.json");
}

export function modelThroughputKey(providerID: string, modelID: string): string {
  return `${providerID}::${modelID}`;
}

function validSample(row: unknown): row is Sample {
  if (!row || typeof row !== "object") return false;
  const { id, at, tokens, ms } = row as Partial<Sample>;
  return typeof id === "string" && id.length > 0 &&
    typeof at === "number" && Number.isFinite(at) && at >= 0 &&
    typeof tokens === "number" && typeof ms === "number" &&
    Number.isFinite(tokens) && Number.isFinite(ms) && tokens >= MIN_SAMPLE_TOKENS - 1 && ms > 0;
}

function mergeSamples(current: Sample[], added: Sample[]): Sample[] {
  const unique = new Map([...current, ...added].map((sample) => [sample.id, sample]));
  return [...unique.values()].sort((a, b) => a.at - b.at).slice(-MAX_MODEL_THROUGHPUT_WINDOW);
}

async function readStats(): Promise<Stats> {
  try {
    const parsed = JSON.parse(await readFile(statsPath(), "utf8")) as unknown;
    // 旧累積形式から個々の応答は復元できないので、新しい計測から蓄積する。
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const stored = parsed as { version?: unknown; models?: unknown };
    if (stored.version !== 2 || !stored.models || typeof stored.models !== "object" || Array.isArray(stored.models)) return {};
    const stats: Stats = Object.create(null);
    for (const [key, rows] of Object.entries(stored.models)) {
      if (!Array.isArray(rows)) continue;
      const samples = mergeSamples([], rows.filter(validSample));
      if (samples.length > 0) stats[key] = samples;
    }
    return stats;
  } catch {
    return {};
  }
}

function addSamples(target: Map<string, Sample[]> | Stats, key: string, samples: Sample[]): void {
  const current = target instanceof Map ? target.get(key) : target[key];
  const next = mergeSamples(current ?? [], samples);
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
  activeBatch = batch;
  pending.clear();
  flushing = (async () => {
    let written = false;
    try {
      await mkdir(dataDir(), { recursive: true });
      written = await withLock(async () => {
        const stats = await readStats();
        for (const [key, samples] of batch) addSamples(stats, key, samples);
        const file = statsPath();
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ version: 2, models: stats }), "utf8");
        await rename(tmp, file);
      });
    } catch {
      written = false;
    }
    if (!written) {
      for (const [key, samples] of batch) addSamples(pending, key, samples);
      scheduleFlush();
    }
  })().finally(() => {
    activeBatch = null;
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
  addSamples(pending, modelThroughputKey(providerID, modelID), [{
    id: randomUUID(), at: performance.timeOrigin + performance.now(), tokens: outputTokens - 1, ms: decodeMs,
  }]);
  scheduleFlush();
}

/** `providerID::modelID` → 設定した直近N件の平均 tok/s（未書き込み分を含む）。 */
export async function readModelThroughputAverages(): Promise<Map<string, number>> {
  // read中にflushが完了しても、開始時点の未保存応答を取りこぼさない。
  const batches = [activeBatch, new Map(pending)];
  const stats = await readStats();
  for (const batch of [...batches, activeBatch, pending]) {
    if (batch) for (const [key, samples] of batch) addSamples(stats, key, samples);
  }
  const window = parseModelThroughputWindow(getSetting(MODEL_THROUGHPUT_WINDOW_SETTING_KEY));
  const averages = new Map<string, number>();
  for (const [key, samples] of Object.entries(stats)) {
    const recent = samples.slice(-window);
    const tokens = recent.reduce((sum, sample) => sum + sample.tokens, 0);
    const ms = recent.reduce((sum, sample) => sum + sample.ms, 0);
    averages.set(key, (tokens * 1000) / ms);
  }
  return averages;
}
