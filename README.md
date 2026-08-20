# LeafCodePi

[LeafCode](https://github.com/daihaya000/LeafCode) の UI/UX 構造を維持した、[Pi Coding Agent](https://github.com/earendil-works/pi) 向けの最低限フロントエンドです。OpenCode は使いません。Pi SDK（`@earendil-works/pi-coding-agent`）を Next.js の BFF に埋め込み、ブラウザからセッションを操作します。

## できること（MVP）

- サイドバー: プロジェクト / タスク一覧、折りたたみ、テーマ切替
- ホーム: プロジェクト選択 + composer + モデル / 思考レベル
- タスク: タイムライン（テキスト・思考・ツールカード）+ SSE ストリーミング + 停止
- 設定: Pi のヘルス、**Claude Pro/Max / ChatGPT Plus/Pro のサブスクログイン**、**llama-server 起動**、プロバイダー認証、利用可能モデル
- プロジェクト追加: パス入力 / フォルダ一覧 / Windows ネイティブ参照
- モデルタブ: 認証済みプロバイダー / モデルの有効・無効とドラッグ並び替え

## ローカル LLM（llama.cpp / llama-server）

`start.bat` 起動後、設定 → エンジン → 「ローカル LLM (llama-server)」から起動・停止できます。

- ポート **8080**（Pi 既定）。LeafCode の llama-server（8081）とは別。
- `MODEL_FILE` 未指定 → ルーター（`--models-dir`）。Pi の `llama.cpp` ログイン向け。
- `MODEL_FILE` 指定 → 単体 GGUF（`-m`）。プロバイダー ID `llama-server`。
- バイナリ既定: `C:\tools\llama.cpp\llama-server.exe`

## サブスクリプション認証

設定 → エンジン → 「サブスクでログイン」からブラウザ OAuth できます。

| プロバイダー | 対象サブスク | Pi 上の ID |
| --- | --- | --- |
| Anthropic | Claude Pro / Max | `anthropic`（oauth） |
| OpenAI Codex | ChatGPT Plus / Pro | `openai-codex` |

トークンは `%USERPROFILE%\.pi\agent\auth.json` に保存されます。コールバックは本機の `127.0.0.1:53692`（Anthropic）と `localhost:1455`（OpenAI Codex）を使います。通常の API キー（`ANTHROPIC_API_KEY` など）も併用できます。

## まだないもの

OpenCode 版 LeafCode にあった worktree 分離、権限カード、差分ペイン、ゴールループ、Caddy は未実装です。エージェントはプロジェクトフォルダ上で Pi の標準ツール（read / write / edit / bash / grep / find / ls）を直接実行します。

## 動作条件

| 項目 | 要件 |
| --- | --- |
| OS | Windows 10/11 x64（macOS / Linux でも WebUI 自体は動きます） |
| Node.js | 20 以上 |
| Pi 認証 | 設定画面のサブスクログイン（Claude Pro/Max / ChatGPT Plus/Pro）、環境変数、または `~/.pi/agent/auth.json` |
| bash（Windows） | Git Bash など。Pi がツール実行に使います |

## 起動

リポジトリ直下の `start.bat` をダブルクリックします。初回は Node.js / 依存関係 / production build を確認し、トレイに常駐します。ソースが `web/.next/BUILD_ID` より新しければ、本家 LeafCode と同じく起動時に `next build` し直します。準備できたら `http://127.0.0.1:3010` を開きます。

トレイメニュー:

- Open browser
- 稼働状況
- Restart WebUI
- Quit

```bat
start.bat
```

開発時だけトレイなしで動かす場合:

```bat
npm --prefix web install
npm run dev
```

デスクトップショートカットは `scripts\create-shortcut.bat` です（`LeafCodePi.lnk`。LeafCode の `LeafCode.lnk` とは別ファイルです）。

プロジェクトデータは `%APPDATA%\leafcode-pi\store.json` に保存します。Pi セッション本体は `~/.pi/agent/sessions/` です。
ホストログと `host.lock` は `%APPDATA%\leafcode-pi\` です。トレイ用 TEMP は `%LOCALAPPDATA%\leafcode-pi\tmp` です。

## LeafCode との同時起動

同じ Windows 上で [LeafCode](https://github.com/daihaya000/LeafCode) と並べて動かせます。既定値は重なりません。

| | LeafCode | LeafCodePi |
| --- | --- | --- |
| WebUI | `http://127.0.0.1:3000` | `http://127.0.0.1:3010` |
| 環境変数 | `LEAFCODE_*` | `LEAFCODE_PI_*` |
| データ | `%APPDATA%\leafcode` | `%APPDATA%\leafcode-pi` |
| トレイ TEMP | `%LOCALAPPDATA%\leafcode\tmp` | `%LOCALAPPDATA%\leafcode-pi\tmp` |
| ショートカット | `LeafCode.lnk` | `LeafCodePi.lnk` |
| コンソール title | LeafCode | LeafCodePi |

`LEAFCODE_PORT` を LeafCodePi に渡しても読みません。ポートを変えるときは `LEAFCODE_PI_PORT` を使います。

## 構成

- `web/` — Next.js UI と BFF
- `host/` — Windows トレイ常駐。Next.js の起動・監視・再起動
- `start.bat` — 導入とホスト起動
- `web/src/lib/pi/harness.ts` — Pi `createAgentSession` のプロセス内シングルトン
- `web/src/lib/store.ts` — プロジェクト / タスクの JSON ストア

## 環境変数

| 変数 | 内容 |
| --- | --- |
| `LEAFCODE_PI_DATA_DIR` | ストアと host.lock / host.log の保存先（未設定時は `%APPDATA%\leafcode-pi`） |
| `LEAFCODE_PI_PORT` | WebUI ポート（既定 **3010**。LeafCode の 3000 と衝突しない） |
| `LEAFCODE_PI_HOST` | WebUI 待ち受け。既定 `tailscale`（Tailscale IPv4。未検出時は 127.0.0.1）。`0.0.0.0` / 明示 IP も可 |
| `LEAFCODE_PI_HOST_CONTROL_PORT` | ホスト制御（llama-server 起動など）。既定 **18775**（LeafCode の 18765 と別） |
| `LEAFCODE_PI_LLAMA_PORT` | llama-server ポート。既定 **8080**（Pi の `LLAMA_BASE_URL` と一致） |
| `LLAMA_BASE_URL` / `LLAMA_API_KEY` | Pi の llama.cpp プロバイダー用（未設定時は `http://127.0.0.1:8080`） |
| `LEAFCODE_PI_MODE` | `prod`（既定・start.bat）または `dev` |
| `LEAFCODE_PI_HEADLESS` | `1` でトレイなし |
| `LEAFCODE_PI_NO_BROWSER` | `1` で起動時にブラウザを開かない |
| `LEAFCODE_PI_NONINTERACTIVE` | `1` で失敗時の pause を省略 |
| `ANTHROPIC_API_KEY` など | Pi が読むプロバイダーキー |
