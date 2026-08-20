# LeafCodePi

[LeafCode](https://github.com/daihaya000/LeafCode) の UI/UX 構造を維持した、[Pi Coding Agent](https://github.com/earendil-works/pi) 向けの最低限フロントエンドです。OpenCode は使いません。Pi SDK（`@earendil-works/pi-coding-agent`）を Next.js の BFF に埋め込み、ブラウザからセッションを操作します。

## できること（MVP）

- サイドバー: プロジェクト / タスク一覧、折りたたみ、テーマ切替
- ホーム: プロジェクト選択 + composer + モデル / 思考レベル
- タスク: タイムライン（テキスト・思考・ツールカード）+ SSE ストリーミング + 停止
- 設定: Pi のヘルス、プロバイダー認証、利用可能モデル
- プロジェクト追加: パス入力 / フォルダ一覧 / Windows ネイティブ参照

## まだないもの

OpenCode 版 LeafCode にあった worktree 分離、権限カード、差分ペイン、ゴールループ、ホストトレイ、Caddy、ログインは未実装です。エージェントはプロジェクトフォルダ上で Pi の標準ツール（read / write / edit / bash / grep / find / ls）を直接実行します。

## 動作条件

| 項目 | 要件 |
| --- | --- |
| OS | Windows 10/11 x64（macOS / Linux でも WebUI 自体は動きます） |
| Node.js | 20 以上 |
| Pi 認証 | `ANTHROPIC_API_KEY` などの環境変数、または `~/.pi/agent/auth.json`（`pi /login`） |
| bash（Windows） | Git Bash など。Pi がツール実行に使います |

## 起動

```bat
cd LeafCodePi
npm --prefix web install
npm run dev
```

ブラウザで `http://127.0.0.1:3000` を開きます。

プロジェクトデータは `%APPDATA%\leafcode-pi\store.json` に保存します。Pi セッション本体は `~/.pi/agent/sessions/` です。

## 構成

- `web/` — Next.js UI と BFF
- `web/src/lib/pi/harness.ts` — Pi `createAgentSession` のプロセス内シングルトン
- `web/src/lib/store.ts` — プロジェクト / タスクの JSON ストア

## 環境変数

| 変数 | 内容 |
| --- | --- |
| `LEAFCODE_PI_DATA_DIR` | ストアの保存先（未設定時は `%APPDATA%\leafcode-pi`） |
| `ANTHROPIC_API_KEY` など | Pi が読むプロバイダーキー |
