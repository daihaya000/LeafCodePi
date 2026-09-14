/** Server/host launch copy. Windows keeps the tray wording; Linux/macOS name start.sh. */

/** Client-safe copy: browsers do not reliably expose the host OS. */
export const HOST_LAUNCH_REQUIRED_HINT_ANY =
  "start.bat（トレイホスト）または ./start.sh / npm run host 経由の起動が必要です。";

export const HOST_RESTART_READY_HINT_ANY =
  "設定画面から WebUI を再起動します（Windows でトレイ常駐時はトレイメニューの Restart WebUI と同じ操作）。";

export function hostLaunchRequiredHint(platform = process.platform): string {
  return platform === "win32"
    ? "start.bat（トレイホスト）経由の起動が必要です。"
    : "./start.sh または npm run host による起動が必要です。";
}

export function hostLaunchCheckHint(platform = process.platform): string {
  return platform === "win32"
    ? "start.bat（トレイホスト）経由で起動しているか確認してください"
    : "./start.sh または npm run host でホストが起動しているか確認してください";
}

export function llamaServerHostCheckHint(platform = process.platform): string {
  return platform === "win32"
    ? "start.bat（トレイホスト）が起動しているか確認してください"
    : "./start.sh または npm run host でホストが起動しているか確認してください";
}

export function hostRestartReadyHint(platform = process.platform): string {
  return platform === "win32"
    ? "トレイメニューの Restart WebUI と同じ操作です。"
    : "設定画面から WebUI を再起動します（トレイ常駐時はトレイメニューの Restart WebUI と同じ操作）。";
}
