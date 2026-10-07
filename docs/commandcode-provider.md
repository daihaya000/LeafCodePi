# Command Code の組み込みプロバイダー

- `pi-commandcode-provider` は必要な外部ライブラリ。`web/package.json` と `web/package-lock.json` でバージョンを管理し、`web` の依存導入時にインストールする。
- `web/src/lib/pi/commandcode-provider.ts` がライブラリを読み込み、`harness.ts` がアカウント別の `ModelRuntime` に直接登録する。認証は既存のアカウント認証ストアを使う。
- グローバル設定 `~/.pi/agent/settings.json` に `npm:pi-commandcode-provider` を追加する必要はない。LeafCodePi のセッション拡張ローダーは同名のグローバル拡張を除外し、二重登録を防ぐ。
- 拡張一覧には表示しない。有効・無効やモデル選択はプロバイダー設定で管理する。
- 更新後は LeafCodePi を再起動する。SDK 経由の送信・アカウント認証・Go プランのフォールバックは `web/src/lib/pi/commandcode-transport-sdk.test.ts` で検証する。

## Responses ストリームの途中終了

- `OpenAI Responses stream ended before a terminal response event` は、終端イベントなしで応答が閉じたエラー。完了チェックを無効化せず、回答・ツール出力開始前に限って同じリクエストを1回再試行する。
- 失敗した試行の思考を重複表示しないため、Responses の初期思考は本文・ツール出力開始まで保留する。上限は65,536文字・8,192イベント。上限到達後は表示を再開し、再試行しない。Chat Completions・Anthropic の思考表示には影響しない。
- 中断・認証エラー・部分回答・不完全なツール呼び出しは再試行せず、2回目の失敗もエラーのまま返す。再試行分の生成費用が追加される場合がある。
- `commandcode-stream-retry.test.ts` と `commandcode-transport-sdk.test.ts` で上限・再試行・終端/ツール検証を確認する。

これは LeafCodePi の組み込み機能であり、リポジトリ外で直接起動する通常の Pi CLI へは自動登録されない。CLI で個別に利用する場合は `pi -e <repo>/web/node_modules/pi-commandcode-provider/index.ts` で明示的に読み込める。
