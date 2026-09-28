/** Host-side OAuth loopback ports. Do not change these URIs; they match Pi / IdP apps. */
export const CLAUDE_OAUTH_CALLBACK_HOST = "127.0.0.1:53692";
export const CODEX_OAUTH_CALLBACK_HOST = "localhost:1455";

export const REMOTE_OAUTH_SSH_FORWARD =
  "ssh -N -L 53692:127.0.0.1:53692 -L 1455:127.0.0.1:1455 user@host";

export const REMOTE_OAUTH_HINT =
  "別端末でも認証できます。認証リンクを開き、ログイン後に localhost / 127.0.0.1 への接続エラーになったら、アドレスバーの戻り先URL全体をコピーし、この画面へ戻って貼り付け・送信してください。接続エラーだけでは認証失敗ではありません。デバイスコード方式は、表示されたコードを認証ページへ入力して完了を待ちます。";

export const REMOTE_OAUTH_MANUAL_LABEL = "認証コード / ログイン後の戻り先URL全体";
