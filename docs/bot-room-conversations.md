# Bot Room の対話制御

## 使い方

- `/discuss 初心者が最初に学ぶ言語について話し合って`：有効なRoomメンバー間で対話する。
- `/discuss @デバッガー @プランナー 設計案を比較して`：指定した参加者だけで対話する。名前の後ろに空白を入れる。
- `二人で会話してみて` なども対応するが、自然文判定は補助的なもの。確実な起動には `/discuss` を使う。
- 通常の `@Bot名 質問` は直接回答、`@here 質問` や「部屋に聞く」は従来どおり独立した一斉回答。
- 新しいユーザー発言（例：`/stop`）で後続ターンを停止する。既に生成中の1発言は完了を待つ。

## 調査した公開実装

名称が似ていても、共有レジストリ・SDK・対話エンジンは別物として比較した。

| 一次資料 | 確認した内容 | 採用・非採用 |
| --- | --- | --- |
| [OpenBot exchange.ts](https://github.com/ashhart/OpenBot/blob/b544cb743986193fdc3d234ae66c8e44ef68fc00/src/main/agent/exchange.ts)、[exchangeBrief.ts](https://github.com/ashhart/OpenBot/blob/b544cb743986193fdc3d234ae66c8e44ef68fc00/src/main/agent/exchangeBrief.ts)、[turnAction.ts](https://github.com/ashhart/OpenBot/blob/b544cb743986193fdc3d234ae66c8e44ef68fc00/src/main/agent/turnAction.ts) | 自己申告の発言制御行、発言ごとの司会指示、最終行・コードフェンス検査、反復停止 | ツール非依存の受け渡し、短いターン指示、反復停止を採用。装飾された制御行の寛容な解釈や再問い合わせは採用せず、曖昧な出力は通常発言として扱う。 |
| [GrokBot SDK discussOnce](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/src/gateway/oneshot.ts) | 指定席を複製して一時グループを作り、全参加者のidleを待ち、全発言を回収。SDK自体はホストの対話エンジンを実装しない | 発言者付き共有履歴と参加者限定を重視。既存Room専用セッションを再利用し、Bot複製やSDK依存は追加しない。 |
| [grok-bot-rooms README](https://github.com/mrlynn/grok-bot-plugin-example/blob/bf5aa243641c007690cd69b22e2b2a5f172f7bbc/README.md) | 登録・在室・メッセージログを共有するMCPレジストリ。Grok Botネイティブのグループチャットではない | 会話スケジューラの参考としては採用しない。外部ホストや共有認証も追加しない。 |
| [AutoGen Termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html) | 各返答後に終了条件を評価し、発言数上限・終了文字列・外部停止などを組み合わせる | 結論・上限・反復・ユーザー割り込みを組み合わせる。別LLMによる発言者選択やフレームワーク導入はしない。 |

外部コードの移植ではなく、上記の制御パターンを既存の `promptTask` とRoom保存処理上に実装した。

## 実装上の契約

- 各ターンで参加者ID・名前・役割、発言者付き履歴、元のユーザー要求、残り発言数を提示する。他のBotの返答を代筆させない。
- 返答末尾の独立した `ROOM_ACTION: NEXT <participant-id>` で次の相手を選ぶ。`ROOM_ACTION: DONE` で終了を提案する。
- 自分自身・無効なBot・今回選択されていないBotへの制御行、引用・コード内・途中の制御行は実行しない。正規の制御行だけを表示用本文から除く。
- `DONE` は有効な参加者全員が少なくとも一度話した後に終了する。それ以前は未発言の参加者へ渡す。
- 発言上限は `min(12, 参加者数 × 3)`。上限に近づいたら未発言者を優先し、最終ターンには結論・未解決点をまとめるよう指示する。
- 制御行を返さないモデルは順番に発言し、最大2巡で止める。同一Botの同一本文の反復（空白差を除く）でも止める。意味の似た言い換えは検出しない。
- メンションは最長の完全名またはIDを優先し、`@Alpha` が `A` を呼んだり、`@here-other` が全員配信になったりしない。
- 履歴は直近30件・JSON約24,000文字まで。巨大な最新発言は切り詰めを明示する。要求本文は別枠で維持する。これはトークン数や総セッションサイズの保証ではない。
- リレー発言はユーザーの権限付与ではない。返信者の `botId` と依頼元の `sourceBotId` を区別する。既存の単発リレー認証・深さ制限は変更しない。
- キュー待ちと準備の後にも、最新要求・在室・有効状態を再確認する。新規要求は待機中の古い対話を失効させる。

## 検証と残る制約

```text
cd web
npx vitest run src/lib/room-conversation.test.ts src/lib/rooms.test.ts "src/app/api/bots/rooms/[id]/prompt/route.test.ts"
npm run typecheck
```

テストはモデル出力を制御し、受け渡し・打ち切り・共有履歴・選択範囲・引用・反復・割り込みを検証する。実モデルが常に自然な議論や正規の制御行を生成する保証ではない。

既存のプロセス内非同期実行を維持しているため、プロセス再起動を跨ぐ対話再開・生成中の強制中断・壁時計の実行期限は未対応。停止後は新しい要求で対話を始める。専用スケジューラ、司会Bot、UI設定、外部依存は追加していない。
