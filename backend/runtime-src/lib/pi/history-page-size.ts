import { HISTORY_PAGE_SIZE_SETTING_KEY, parseHistoryPageSize } from "@/lib/history-page-size";
import { getSetting } from "@/lib/pi/web-settings";

/** サーバ設定の履歴1ページ件数。設定ファイルはmtimeキャッシュ済みなので呼び出しごとに読んでよい。 */
export function readHistoryPageSize(): number {
  return parseHistoryPageSize(getSetting(HISTORY_PAGE_SIZE_SETTING_KEY));
}
