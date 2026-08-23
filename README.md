# LeafCodePi

[LeafCode](https://github.com/daihaya000/LeafCode) の UI/UX 構造を維持した、[Pi Coding Agent](https://github.com/earendil-works/pi) 向けの最低限フロントエンドです。OpenCode は使いません。Pi SDK（`@earendil-works/pi-coding-agent`）を Next.js の BFF に埋め込み、ブラウザからセッションを操作します。

## できること（MVP）

- サイドバー: プロジェクト / タスク一覧、折りたたみ、テーマ切替
- ホーム: プロジェクト選択 + composer + モデル / 思考レベル
- タスク: タイムライン（テキスト・思考・ツールカード）+ SSE ストリーミング + 停止 + **コンテキスト使用量**
- 設定: Pi のヘルス、**llama-server 起動**、再起動。**一般タブでグローバル AGENTS.md**。モデルタブで **Claude / ChatGPT / Cursor サブスク**、**Ollama Cloud**、有効・無効・並び替え、有効モデル一覧
- プロジェクト追加: ホスト PC ではクリック時にエクスプローラー（ネイティブフォルダ選択）を直接開き、選択で即追加。リモートはパス入力 / アプリ内フォルダ一覧
- モデルタブ: サブスクログイン、Ollama Cloud API キー、認証済みプロバイダー / モデルの有効・無効とドラッグ並び替え、有効モデル一覧

## カスタム指示（AGENTS.md）

設定 → 一般 → 「カスタム指示（AGENTS.md）」から `~/.pi/agent/AGENTS.md` を編集できます（全プロジェクト共通）。保存時に開いているセッションへ即時反映します。プロジェクト単位の AGENTS.md 編集は未対応です。

## ローカル LLM（llama.cpp / llama-server）

`start.bat` 起動後、設定 → エンジン → 「ローカル LLM (llama-server)」から起動・停止できます。

- ポート **8081**（LeafCode の llama-server と同じ。片方を起動すれば共有可）。
- `MODEL_FILE` 未指定 → ルーター（`--models-dir`）。Pi の `llama.cpp` ログイン向け。
- `MODEL_FILE` 指定 → 単体 GGUF（`-m`）。プロバイダー ID `llama-server`。
- バイナリ既定: `C:\tools\llama.cpp\llama-server.exe`

## Ollama Cloud

設定 → モデル → Ollama Cloud で API キーを登録するか、環境変数 `OLLAMA_API_KEY` を設定します（[キー発行](https://ollama.com/settings/keys)）。

- エンドポイント: `https://ollama.com/v1`（OpenAI 互換）
- プロバイダー ID: `ollama-cloud`
- モデル一覧はログイン後に `/v1/models` から取得

## サブスクリプション認証

設定 → モデル → 「サブスクでログイン」からブラウザ OAuth できます。

| プロバイダー | 対象サブスク | Pi 上の ID |
| --- | --- | --- |
| Anthropic | Claude Pro / Max | `anthropic`（oauth） |
| OpenAI Codex | ChatGPT Plus / Pro | `openai-codex` |
| Cursor | Cursor サブスク | `cursor`（`@rahularya01/pi-cursor`） |
| Ollama Cloud | API キー | `ollama-cloud` |

Cursor は非公式拡張です。本機の Cursor IDE / CLI のトークンを使うか、設定画面から「サブスクでログイン」します。Node.js **22.19+** を推奨します。

トークンは `%USERPROFILE%\.pi\agent\auth.json` に保存されます。コールバックは本機の `127.0.0.1:53692`（Anthropic）と `localhost:1455`（OpenAI Codex）を使います。通常の API キー（`ANTHROPIC_API_KEY` など）も併用できます。

## Goal Loop

`extensions/leafcode-goal-loop` に LeafCode 互換の Pi 拡張を同梱しています。登録すると Home / Task の Composer に「ループ」「承認条件」「最大ターン」「クールタイム」「完走モード」が表示されます。

```bash
pi install ./extensions/leafcode-goal-loop
```

通常モードは完了宣言を検証ターンで確認し、完走モードは完了宣言を無視して指定ターン数まで実行します。最大ターンを `0` にすると無制限、クールタイムは `15m 30s` のように指定できます。状態は各プロジェクトの `.pi/goals-loop/` に保存されます。

## ToDo (`todowrite`)

`extensions/leafcode-todowrite` は OpenCode の `todowrite` と
`C:\Users\Daichi\.agents\skills\todowrite-discipline` の形式に合わせた Pi 拡張です。
`pending` / `in_progress` / `completed` / `cancelled`、`high` / `medium` / `low` を扱い、
`in_progress` は同時に1件だけ許可します。Pi セッションの tool result に状態を保存し、
Task 画面には本家 LeafCode と同様の折りたたみ式 ToDo 進捗とプログレスバーを表示します。

```bash
pi install ./extensions/leafcode-todowrite
```

## まだないもの

OpenCode 版 LeafCode にあった worktree 分離、権限カード、差分ペイン、Caddy は未実装です。エージェントはプロジェクトフォルダ上で Pi の標準ツール（read / write / edit / bash / grep / find / ls）を直接実行します。

## 動作条件

| 項目 | 要件 |
| --- | --- |
| OS | Windows 10/11 x64（macOS / Linux でも WebUI 自体は動きます） |
| Node.js | 20 以上 |
| Pi 認証 | 設定画面のサブスクログイン（Claude Pro/Max / ChatGPT Plus/Pro）、環境変数、または `~/.pi/agent/auth.json` |
| bash（Windows） | Git Bash など。Pi がツール実行に使います |

## 起動

リポジトリ直下の `start.bat` をダブルクリックします。初回は Node.js / 依存関係 / production build を確認し、トレイに常駐します。ソースがビルドより新しければ、本家 LeafCode と同じく起動時に `next build` し直します。準備できたら `http://127.0.0.1:3010` を開きます。

本家 LeafCode と同じく、ホスト PC 上のブラウザが Tailscale / LAN IP で WebUI を開いた場合は `127.0.0.1` へ自動リダイレクトします（リモート端末はリダイレクトされません）。

ビルドが稼働中の `next start` の `.next` を置き換えたときは、そのままだと配信中の HTML が参照するチャンクが消えて `/_next/static/...` が 500 になり、キャッシュを持たないクライアント（スマホなど）に Next の "This page couldn't load" が出ます。`scripts/build-web.mjs` はビルド後に稼働中の WebUI を検出したら、ホスト制御の `POST /restart/webui` で新しい世代へ切り替えます。ホストに届かない場合はトレイの Restart WebUI が必要です。

production build は本家 LeafCode と同じく **`%LOCALAPPDATA%\leafcode-pi\build\<checkout>-<hash>\`** のハードリンクミラーで実行し、`next start` もそこから配信します。OneDrive がビルド中・配信中の `.next` に触れてチャンク世代が混ざるのを防ぐためです（`scripts\web-build-mirror.mjs`）。`next dev` はリポジトリのまま動きます（Next 16 の dev 出力は `web/.next/dev` で prod と分離）。ミラーの場所は `LEAFCODE_PI_BUILD_DIR` で変更できます。

トレイメニュー:

- Open browser
- 稼働状況
- Restart WebUI
- Quit（次回起動時に必要な production build があれば、先にビルドしてから終了）

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
- `scripts/build-web.mjs` — production build の唯一の入口（ミラー同期 → `next build` → BUILD_ID 検証）
- `scripts/web-build-mirror.mjs` — OneDrive 外へのハードリンクミラー
- `web/src/lib/pi/harness.ts` — Pi `createAgentSession` のプロセス内シングルトン
- `web/src/lib/store.ts` — プロジェクト / タスクの JSON ストア

## 環境変数

| 変数 | 内容 |
| --- | --- |
| `LEAFCODE_PI_DATA_DIR` | ストアと host.lock / host.log の保存先（未設定時は `%APPDATA%\leafcode-pi`） |
| `LEAFCODE_PI_PORT` | WebUI ポート（既定 **3010**。LeafCode の 3000 と衝突しない） |
| `LEAFCODE_PI_HOST` | WebUI 待ち受け。既定 `tailscale`（Tailscale IPv4。未検出時は 127.0.0.1）。`0.0.0.0` / 明示 IP も可 |
| `LEAFCODE_PI_HOST_CONTROL_PORT` | ホスト制御（llama-server 起動など）。既定 **18775**（LeafCode の 18765 と別） |
| `LEAFCODE_PI_LLAMA_PORT` | llama-server ポート。既定 **8081** |
| `LLAMA_BASE_URL` / `LLAMA_API_KEY` | Pi の llama.cpp プロバイダー用（未設定時は `http://127.0.0.1:8081`） |
| `LEAFCODE_PI_MODE` | `prod`（既定・start.bat）または `dev` |
| `LEAFCODE_PI_BUILD_DIR` | production build のミラー先（未設定時は `%LOCALAPPDATA%\leafcode-pi\build\<checkout>-<hash>`） |
| `LEAFCODE_PI_USE_WEBPACK` | `1` で `next build` を Turbopack でなく webpack で行う（切り分け用） |
| `LEAFCODE_PI_HEADLESS` | `1` でトレイなし |
| `LEAFCODE_PI_NO_BROWSER` | `1` で起動時にブラウザを開かない |
| `LEAFCODE_PI_NONINTERACTIVE` | `1` で失敗時の pause を省略 |
| `ANTHROPIC_API_KEY` など | Pi が読むプロバイダーキー |
