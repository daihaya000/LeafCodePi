import type { JevLatencyStats } from "@/lib/jev-model-settings";
import { getSetting, updateSettingsFile } from "./web-settings";

/**
 * Jev判定のHTTP応答時間をモデル別に蓄積するサーバー専用ストア。
 * web-settings.json の1キーへ保存し、設定の保存コードと同じロックで直列化する。
 * キーはレスポンスが返した実モデル名（プロバイダ横断）。同一IDが別プロバイダに
 * あっても合算されるが、表示は「実測でそのモデルが答えた時間」を意味する。
 * 判定完了後に呼ばれる同期書き込みで、ロック競合は通常ミリ秒で解ける。
 */
export const JEV_LATENCY_SETTING_KEY = "jev-latency";
/** これを超えたモデルは updatedAt の古い順に削除し、ファイルの肥大化を防ぐ。 */
export const JEV_LATENCY_MAX_MODELS = 64;
/** タイムアウト上限120秒を十分に超える値は計測ノイズとして捨てる。 */
const JEV_LATENCY_MAX_SAMPLE_MS = 10 * 60 * 1000;
const MODEL_ID_MAX_CHARS = 256;

type JevLatencyRecord = { count: number; totalMs: number; lastMs: number; updatedAt: number };
type JevLatencyFile = { version: 1; models: Record<string, JevLatencyRecord> };

function emptyFile(): JevLatencyFile {
  return { version: 1, models: {} };
}

/** モデルID規約は設定側と同じ: 空白・制御文字なしの256文字以内。 */
function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MODEL_ID_MAX_CHARS &&
    !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** 保存値は外部由来として扱い、壊れた項目は捨てて残りを活かす。 */
function parseLatencyFile(raw: unknown): JevLatencyFile {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 32_768) return emptyFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyFile();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyFile();
  const models = (parsed as { models?: unknown }).models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return emptyFile();
  const file = emptyFile();
  for (const [model, record] of Object.entries(models)) {
    if (!isModelId(model) || !record || typeof record !== "object" || Array.isArray(record)) continue;
    const { count, totalMs, lastMs, updatedAt } = record as Record<string, unknown>;
    if (!isNonNegativeInteger(count) || count < 1 || !isNonNegativeInteger(totalMs) || !isNonNegativeInteger(lastMs)) continue;
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) continue;
    file.models[model] = { count, totalMs, lastMs, updatedAt };
  }
  return file;
}

/**
 * 成功したJev判定1回分を記録する。計測は判定の付属物なので、
 * 不正な値も保存失敗も投げずに無視する（呼び出し元の判定を壊さない）。
 */
export function recordJevLatency(model: string, durationMs: number): void {
  if (!isModelId(model) || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > JEV_LATENCY_MAX_SAMPLE_MS) return;
  const sample = Math.round(durationMs);
  try {
    updateSettingsFile((settings) => {
      const file = parseLatencyFile(settings[JEV_LATENCY_SETTING_KEY]);
      const previous = file.models[model];
      file.models[model] = {
        count: (previous?.count ?? 0) + 1,
        totalMs: (previous?.totalMs ?? 0) + sample,
        lastMs: sample,
        updatedAt: Date.now(),
      };
      const entries = Object.entries(file.models);
      if (entries.length > JEV_LATENCY_MAX_MODELS) {
        entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        for (const [key] of entries.slice(0, entries.length - JEV_LATENCY_MAX_MODELS)) delete file.models[key];
      }
      settings[JEV_LATENCY_SETTING_KEY] = JSON.stringify(file);
    });
  } catch {
    /* 設定ファイルの読み書き失敗でJev判定を失敗させない。 */
  }
}

/** 設定画面・APIへ返すモデル別サマリー（平均は丸めたミリ秒）。 */
export function readJevLatencyStats(): JevLatencyStats {
  const file = parseLatencyFile(getSetting(JEV_LATENCY_SETTING_KEY));
  const stats: JevLatencyStats = {};
  for (const [model, record] of Object.entries(file.models)) {
    stats[model] = {
      count: record.count,
      averageMs: Math.round(record.totalMs / record.count),
      lastMs: record.lastMs,
    };
  }
  return stats;
}
