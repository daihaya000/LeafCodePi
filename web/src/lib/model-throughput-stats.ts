import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";

/** モデルごとの tok/s 実績（合計と件数）。キーは `providerID::modelID`。 */
type Stats = Record<string, { sum: number; count: number }>;

function statsPath(): string {
  return join(dataDir(), "model-throughput.json");
}

export function modelThroughputKey(providerID: string, modelID: string): string {
  return `${providerID}::${modelID}`;
}

function readStats(): Stats {
  try {
    const parsed = JSON.parse(readFileSync(statsPath(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Stats) : {};
  } catch {
    return {};
  }
}

/** 応答1件の tok/s を実績へ加算する（best-effort）。 */
export function recordModelThroughput(providerID: string, modelID: string, rate: number): void {
  if (!providerID || !modelID || !Number.isFinite(rate) || rate <= 0) return;
  try {
    const stats = readStats();
    const key = modelThroughputKey(providerID, modelID);
    const row = stats[key];
    stats[key] =
      row && Number.isFinite(row.sum) && Number.isFinite(row.count)
        ? { sum: row.sum + rate, count: row.count + 1 }
        : { sum: rate, count: 1 };
    const file = statsPath();
    mkdirSync(dataDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(stats), "utf8");
    renameSync(tmp, file);
  } catch {
    /* 実績集計は表示用。失敗しても応答処理は止めない */
  }
}

/** `providerID::modelID` → 平均 tok/s。 */
export function readModelThroughputAverages(): Map<string, number> {
  const averages = new Map<string, number>();
  for (const [key, row] of Object.entries(readStats())) {
    if (row && Number.isFinite(row.sum) && Number.isFinite(row.count) && row.count > 0) {
      averages.set(key, row.sum / row.count);
    }
  }
  return averages;
}
