import { statSync } from "node:fs";
import { getHeapStatistics } from "node:v8";

const MIB = 1024 * 1024;
// SessionManager.open materializes the entire JSONL, parsed entries and branch context.
// A cache limit applied AFTER open cannot protect the process from that allocation.
export const MAX_SESSION_LOAD_BYTES = 64 * MIB;
export const MIN_SESSION_LOAD_RESERVE_BYTES = 512 * MIB;
export const SESSION_LOAD_EXPANSION_FACTOR = 8;

export function readRuntimeMemory() {
  const { heapUsed, rss, external, arrayBuffers } = process.memoryUsage();
  return { heapUsed, heapLimit: getHeapStatistics().heap_size_limit, rss, external, arrayBuffers };
}

export function isRuntimeMemoryPressure(memory) {
  return memory.heapLimit - memory.heapUsed <= Math.max(MIN_SESSION_LOAD_RESERVE_BYTES, memory.heapLimit * 0.25);
}

/** Reject before the SDK allocates; never truncate, rewrite or reset user history. */
export function assertSessionLoadAllowed(file, {
  readMemory = readRuntimeMemory,
  stat = statSync,
} = {}) {
  const bytes = file ? stat(file).size : 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_SESSION_LOAD_BYTES) {
    throw Object.assign(new Error("セッション履歴が安全な読み込み上限（64 MiB）を超えています。元の履歴は保持されています。新規セッションで続行してください。"), {
      status: 413, code: "SESSION_FILE_TOO_LARGE",
    });
  }
  const memory = readMemory();
  const reserve = Math.max(MIN_SESSION_LOAD_RESERVE_BYTES, memory.heapLimit * 0.25);
  if (isRuntimeMemoryPressure(memory) || memory.heapUsed + bytes * SESSION_LOAD_EXPANSION_FACTOR + reserve > memory.heapLimit) {
    throw Object.assign(new Error("Backendのメモリ余裕が不足しているため、追加のセッション読み込みを保留しました。不要な休止セッションを閉じてから再試行してください。"), {
      status: 503, code: "SESSION_MEMORY_PRESSURE",
    });
  }
}
