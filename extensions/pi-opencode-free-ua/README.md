# pi-opencode-free-ua

OpenCode Zen無料モデル向けのPi 1.x互換拡張。`/reload`で再読み込みする。

- SDKが既定で付ける`x-opencode-client: pi`を`opencode`へ補正する。
- ヘッダー名の大文字小文字・重複・空値を正規化する。明示した独自クライアント値とセッションIDは保持する。
- 会話外の直接生成にもセッションIDを付ける。会話IDがある場合はそれを優先する。
- 無料のResponsesモデルをChat Completionsへ投影する。有料モデルは変更しない。
- SDK標準の認証・送信処理・分類モデルを保持する。内部JSONカタログの読み直しや全モデルの旧式再登録は行わない。
- `FreeTierError`には利用制限の説明を追加する。他の403・401・429・中断・コンテキスト超過は変更しない。

## 制約

ヘッダー補正はサーバー側の利用許可を保証しない。2026-10-10の実API確認ではSpace Bunny Freeの応答に成功した一方、Muse Spark 1.3 Contributor Freeは認証あり・なしの両方で`403 FreeTierError`だった。User-Agent追加でも拒否された。

`/reload`後もこのエラーが続く場合はOpenCode本体、または利用可能な別の無料モデルを使う。この拡張は有料モデルへの自動切替、クライアントIDのローテーション、利用制限への無限再試行を行わない。

## 検証

```sh
node --test extensions/pi-opencode-free-ua/index.test.mjs
```

テストはローカルHTTPサーバーを使う。外部API・実認証情報は使用しない。Pi SDK 1.0.0以降とNode.js 22.19以降が必要。
