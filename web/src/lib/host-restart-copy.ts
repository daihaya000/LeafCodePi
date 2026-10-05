export type RestartTarget = "webui" | "backend" | "host";

export const RESTART_LABELS: Record<RestartTarget, string> = {
  webui: "WebUI",
  backend: "バックエンド（Piランタイム）",
  host: "トレイホスト",
};

const PULL_NOTE = "最初に最新ソースを取得";
const FALLBACK_NOTE = "ビルド失敗時は前回のビルドで起動します";
export const RESTART_CONFIRM_NOTES: Record<RestartTarget, string> = {
  webui: `（${PULL_NOTE}し、フロントエンドを再ビルド・再起動します。${FALLBACK_NOTE}。実行中のセッションはバックエンドで継続します）`,
  backend: `（${PULL_NOTE}し、バックエンドを再ビルド・再起動します。${FALLBACK_NOTE}。実行中のセッションはすべて終了します。WebUIは再起動しません）`,
  host: `（${PULL_NOTE}し、フロントエンドとバックエンドを再ビルド・再起動します。${FALLBACK_NOTE}。実行中のセッションは終了します）`,
};

export function restartConfirmation(target: RestartTarget): string {
  return `${RESTART_LABELS[target]}を再起動しますか？${RESTART_CONFIRM_NOTES[target]}`;
}
