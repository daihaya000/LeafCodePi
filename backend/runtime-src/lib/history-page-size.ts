import {
  clampTaskMessagePageSize,
  MAX_TASK_MESSAGE_PAGE_SIZE,
  MIN_TASK_MESSAGE_PAGE_SIZE,
  TASK_MESSAGE_PAGE_SIZE,
} from "@shared/task-history.mjs";

/** 履歴1ページ（初回表示と「過去の履歴を読み込む」）で取得するメッセージ数。サーバのみが参照する。 */
export const HISTORY_PAGE_SIZE_SETTING_KEY = "history-page-size";
export const DEFAULT_HISTORY_PAGE_SIZE = TASK_MESSAGE_PAGE_SIZE;
export const MIN_HISTORY_PAGE_SIZE = MIN_TASK_MESSAGE_PAGE_SIZE;
export const MAX_HISTORY_PAGE_SIZE = MAX_TASK_MESSAGE_PAGE_SIZE;
export const HISTORY_PAGE_SIZE_OPTIONS = [50, 100, 150, 200, 300, 500, 1000] as const;

export function clampHistoryPageSize(value: unknown): number {
  return clampTaskMessagePageSize(value);
}

/** 保存値が未設定なら既定値、不正値も既定値へ戻す。 */
export function parseHistoryPageSize(value: string | null): number {
  return value === null ? DEFAULT_HISTORY_PAGE_SIZE : clampHistoryPageSize(value);
}
