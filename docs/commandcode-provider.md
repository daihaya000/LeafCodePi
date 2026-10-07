# Command Code の組み込みプロバイダー

- `pi-commandcode-provider` は必要な外部ライブラリ。`web/package.json` と `web/package-lock.json` でバージョンを管理し、`web` の依存導入時にインストールする。
- `web/src/lib/pi/commandcode-provider.ts` がライブラリを読み込み、`harness.ts` がアカウント別の `ModelRuntime` に直接登録する。認証は既存のアカウント認証ストアを使う。
- グローバル設定 `~/.pi/agent/settings.json` に `npm:pi-commandcode-provider` を追加する必要はない。LeafCodePi のセッション拡張ローダーは同名のグローバル拡張を除外し、二重登録を防ぐ。
- 拡張一覧には表示しない。有効・無効やモデル選択はプロバイダー設定で管理する。
- 更新後は LeafCodePi を再起動する。SDK 経由の送信・アカウント認証・Go プランのフォールバックは `web/src/lib/pi/commandcode-transport-sdk.test.ts` で検証する。

これは LeafCodePi の組み込み機能であり、リポジトリ外で直接起動する通常の Pi CLI へは自動登録されない。CLI で個別に利用する場合は `pi -e <repo>/web/node_modules/pi-commandcode-provider/index.ts` で明示的に読み込める。
