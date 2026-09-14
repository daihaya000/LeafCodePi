/** Host-side OAuth loopback ports. Do not change these URIs; they match Pi / IdP apps. */
export const CLAUDE_OAUTH_CALLBACK_HOST = "127.0.0.1:53692";
export const CODEX_OAUTH_CALLBACK_HOST = "localhost:1455";

export const REMOTE_OAUTH_SSH_FORWARD =
  "ssh -N -L 53692:127.0.0.1:53692 -L 1455:127.0.0.1:1455 user@host";

export const REMOTE_OAUTH_HINT =
  `リモートから WebUI を開いている場合、OAuth の戻り先はホストの ${CLAUDE_OAUTH_CALLBACK_HOST}（Claude）と ${CODEX_OAUTH_CALLBACK_HOST}（Codex）です。手元ブラウザでは ${REMOTE_OAUTH_SSH_FORWARD} でポートフォワードするか、API キー / デバイスコードを使ってください。同じマシンのブラウザなら不要です。`;
