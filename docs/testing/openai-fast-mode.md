# OpenAI Fastモードの検証

## 原因と判定方法

ChatGPT認証のCodexはFast指定時にも `response.service_tier: "default"` を返す。
この値を `priority` と比較して不合格にする検証は誤り。

- Codex公式の `ServiceTier::Fast` はリクエストでは `priority` に変換される。
- Codex OAuthでは、公式と同じ送信値と正常終了を確認する。応答tierから優先処理の有無・実速度は断定しない。
- APIキーのOpenAI Responsesでは応答tierが処理tierを表す。Codexの例外をこちらには適用しない。
- 速度は負荷・キャッシュ・生成内容に依存する。短い応答数件の時間比較を有効化判定には使わない。

公式根拠:

- [Codexメンテナーによる説明](https://github.com/openai/codex/issues/14204#issuecomment-4033184620)
- [CodexのFast送信値](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs)
- [OpenAI API Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)

## オフライン回帰テスト

`web/` で実行:

```powershell
npx vitest run src/lib/pi/openai-fast-mode.e2e.test.ts
```

実SDKとローカルサーバーで以下を確認する:

- OpenAI Responses/SSE、Codex/SSE、Codex/WebSocket、Codex/キャッシュ付きWebSocketの実受信payload。
- 同一セッションのOFF→ON→OFFで、未指定→`priority`→未指定となること。
- CodexのFast応答が `default` でも正常終了すること。
- 指定したtransportで実際に通信したこと（別経路へのフォールバックでの偽陽性を防ぐ）。

## 実APIスモークテスト（明示的なopt-in）

登録済み・有効・残量のあるCodexアカウントのIDを指定する。既定認証の
`~/.pi/agent/auth.json` にフォールバックしない。実リクエストは利用枠を消費する。

`web/` で実行:

```powershell
$env:LEAFCODE_FAST_LIVE_ACCOUNT_ID = "<registered-account-uuid>"
$env:LEAFCODE_FAST_LIVE_DATA_DIR = Join-Path $env:APPDATA "leafcode-pi"
$env:LEAFCODE_FAST_LIVE_MODEL = "gpt-5.5"
try {
  npx vitest run src/lib/pi/openai-fast-mode.live.test.ts
} finally {
  Remove-Item Env:LEAFCODE_FAST_LIVE_ACCOUNT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:LEAFCODE_FAST_LIVE_MODEL -ErrorAction SilentlyContinue
  Remove-Item Env:LEAFCODE_FAST_LIVE_DATA_DIR -ErrorAction SilentlyContinue
}
```

独自データ配置なら `LEAFCODE_FAST_LIVE_DATA_DIR`、独自認証配置なら
`LEAFCODE_FAST_LIVE_AGENT_DIR` に実際のディレクトリを指定する。
Vitestの隔離設定は変更しない。

各transportでOFF/ONの2リクエストを送る。出力はモデル、transport、Fast指定、
送信tier、応答tier、終了状態だけ。認証情報は出力しない。
設定・セッションは一時ディレクトリに隔離し、本番のFast設定は変えない。

アカウントID未指定なら実APIテストはskipされる。APIエラー・timeout・認証切れ・
利用上限・拡張エラーは失敗として扱い、成功に読み替えない。
