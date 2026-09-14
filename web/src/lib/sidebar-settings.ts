export const PINNED_TASKS_SETTING_KEY = "sidebar-pinned-tasks";
export const PINNED_TASKS_API_PATH = `/api/settings/${PINNED_TASKS_SETTING_KEY}`;

const MAX_PINNED_TASK_IDS = 500;
const MAX_TASK_ID_LENGTH = 256;

/** 設定APIへ保存するピン留めIDを検証・重複排除する。 */
export function normalizePinnedTaskIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PINNED_TASK_IDS) return null;
  if (value.some((item) => typeof item !== "string" || item.length === 0 || item.length > MAX_TASK_ID_LENGTH)) {
    return null;
  }
  return [...new Set(value)];
}

/** JSON文字列の設定値を検証してID一覧へ変換する。 */
export function parsePinnedTaskIds(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    return normalizePinnedTaskIds(JSON.parse(value));
  } catch {
    return null;
  }
}

export function serializePinnedTaskIds(ids: Iterable<string>): string {
  return JSON.stringify(normalizePinnedTaskIds([...ids]) ?? []);
}
