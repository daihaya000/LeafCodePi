# LeafCodePi

[LeafCode](https://github.com/daihaya000/LeafCode) の UI/UX 構造を維持した、[Pi Coding Agent](https://github.com/earendil-works/pi) 向けの最低限フロントエンドです。OpenCode は使いません。Pi SDK（`@earendil-works/pi-coding-agent`）を Next.js の BFF に埋め込み、ブラウザからセッションを操作します。

## できること（MVP）

- サイドバー: プロジェクト / タスク一覧、折りたたみ、テーマ切替
- ホーム: プロジェクト選択 + composer + モデル / 思考レベル
- タスク: タイムライン（テキスト・思考・ツールカード）+ SSE ストリーミング + 停止 + **コンテキスト使用量**
- 設定: Pi のヘルス、**llama-server 起動**、再起動。**一般タブでグローバル AGENTS.md**。モデルタブで **Claude / ChatGPT / Cursor サブスク**、**Ollama Cloud**、有効・無効・並び替え、有効モデル一覧
- プロジェクト追加: ホスト PC ではクリック時にエクスプローラー（ネイティブフォルダ選択）を直接開き、選択で即追加。リモートはパス入力 / アプリ内フォルダ一覧

## カスタム指示（AGENTS.md）

設定 → 一般 → 「カスタム指示（AGENTS.md）」から `~/.pi/agent/AGENTS.md` を編集できます（全プロジェクト共通）。保存時に開いているセッションへ即時反映します。プロジェクト単位の AGENTS.md 編集は未対応です。

## ローカル LLM（llama-server）

`start.bat` 起動後、設定 → エンジン → 「ローカル LLM (llama-server)」から起動・停止できます。

- ポート **8081**（LeafCode の llama-server と同じ。片方を起動すれば共有可）。
- `MODEL_FILE` 未指定 → ルーター（`--models-dir`）でモデルを切り替え。
- `MODEL_FILE` 指定 → 単体 GGUF（`-m`）。プロバイダー ID `llama-server`。
- Windows のバイナリ既定: `C:\tools\llama.cpp\llama-server.exe`
- Linux/macOS: 設定画面でバイナリを指定するか、`LEAFCODE_PI_LLAMA_SERVER_BIN`（未設定時は PATH の `llama-server`）を設定します。モデルディレクトリの既定は `~/models/llm` です。Linux/macOS では host がバイナリを detached process として直接起動します。

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

トークンは Windows では `%USERPROFILE%\.pi\agent\auth.json`、Linux/macOS では `~/.pi/agent/auth.json` に保存されます。コールバックは本機の `127.0.0.1:53692`（Anthropic）と `localhost:1455`（OpenAI Codex）を使います。通常の API キー（`ANTHROPIC_API_KEY` など）も併用できます。

## マルチアカウント（ChatGPT / Claude の複数アカウント）

設定 → モデル → 「アカウント」から、ChatGPT (Codex) と Claude のサブスクアカウントを複数登録してタスクごとに切り替えられます（[計画](docs/plans/multi-account.md)）。

- 追加アカウントのトークンは `%USERPROFILE%\.pi\agent\accounts\<accountId>\auth.json` に保存されます（既定の auth.json は不変）
- Home の Composer でアカウントを選ぶと、そのタスクとモデル一覧がそのアカウントに紐づきます。未選択 = 既定
- アカウントが無い場合は選択 UI 自体が非表示になります。OAuth のログインフローは同時に 1 件のみです
- 実行中のタスクから参照されているアカウントは削除できません。認証ファイルは削除後も残ります（手動削除は `%USERPROFILE%\.pi\agent\accounts\` 配下）

## 同梱拡張

LeafCodePi には次の Pi 拡張を同梱しています。WebUI と連携する拡張はリポジトリから自動的に読み込まれます。

| 拡張 | 役割 |
| --- | --- |
| `leafcode-commit-guard` | 未コミット変更を検出したときのコミット確認（拡張は WebUI 依存で常時読込・機能は設定で ON/OFF） |
| `settle-followup-claim` | todowrite / commit-guard の settle follow-up 排他用共有モジュール（拡張ではない） |
| `leafcode-goal-loop` | Goal Loop と完走モード |
| `leafcode-intercom` | 並行 Pi セッション間の1対1通信（`intercom`、`/intercom`、Alt+M） |
| `leafcode-memory` | 永続メモリ、セッション検索、手続き型スキル |
| `leafcode-mcp-adapter` | MCP サーバー接続とツール呼び出し |
| `leafcode-permission-gate` | ツール実行の権限ゲート |
| `leafcode-question` | WebUI からの質問応答 |
| `leafcode-subagents` | サブエージェント委譲、エージェント定義、スキル、プロンプト |
| `leafcode-todowrite` | OpenCode 互換の ToDo 管理 |
| `leafcode-tts` | Bot / エージェントの発言の読み上げ（`/tts`・既定 OFF・唯一無効化できる leafcode 拡張） |
| `leafcode-web-access` | Web 検索、URL/PDF/GitHub/動画の取得・解析 |

ルートの `skills/` と `extensions/*/skills/` 配下にある `SKILL.md` は LeafCodePi の組み込みスキルとして自動検出され、通常の Pi スキルと同じく設定画面から有効／無効を切り替えられます。グローバルディレクトリへのコピーやインストールは不要です。エージェントは `available_skills` の `location` に提示された実パスを読み、相対参照はその `SKILL.md` のディレクトリを基準に解決します。存在しないグローバルパスを指定した場合だけ、有効な一覧から一意に対応するスキルへの `read` を補正し、実パスを結果に明示します。既存ファイルや書き込み先は変更しません。

### Goal Loop

`extensions/leafcode-goal-loop` に LeafCode 互換の Pi 拡張を同梱しています。登録すると Home / Task の Composer に「ループ」「承認条件」「最大ターン」「クールタイム」「完走モード」が表示されます。

```powershell
pi install ./extensions/leafcode-goal-loop
```

通常モードは完了宣言を検証ターンで確認し、完走モードは完了宣言を無視して指定ターン数まで実行します。最大ターンを `0` にすると無制限、クールタイムは `15m 30s` のように指定できます。状態は各プロジェクトの `.pi/goals-loop/` に保存されます。

### ToDo (`todowrite`)

`extensions/leafcode-todowrite` は OpenCode の `todowrite` と
組み込みの [`skills/todowrite-discipline/SKILL.md`](skills/todowrite-discipline/SKILL.md) の形式に合わせた Pi 拡張です。
`pending` / `in_progress` / `completed` / `cancelled`、`high` / `medium` / `low` を扱い、
`in_progress` は同時に1件だけ許可します。Pi セッションの tool result に状態を保存し、
Task 画面には本家 LeafCode と同様の折りたたみ式 ToDo 進捗とプログレスバーを表示します。

起票漏れを防ぐため、`in_progress` を含む non-empty の ToDo を登録する前の変更、shell、委譲、memory変更、未分類toolを停止します。
`git status` / `git diff` を PowerShell / bash で実行する開始時のGit確認も shell に含まれるため、変更タスクでは初回Git確認より先に `todowrite` を呼びます。通常のread-only作業も3回目までに起票が必要です。`AGENTS.md` / `SKILL.md` の確認と制御toolは対象外です。
streaming中の `steer` / `followUp` とextension入力は現在のタスクの継続として扱います。

```powershell
pi install ./extensions/leafcode-todowrite
```

### MCP

`extensions/leafcode-mcp-adapter` に `pi-mcp-adapter` の LeafCodePi 組み込みフォークを同梱しています。

```powershell
pi install ./extensions/leafcode-mcp-adapter
```

設定は `.mcp.json` または `~/.pi/agent/mcp.json` の `mcpServers` に記述します。

### Intercom

`extensions/leafcode-intercom` に `pi-intercom` の LeafCodePi 組み込みフォークを同梱しています。`intercom` ツール、`/intercom`、Alt+M で別セッションへ1対1メッセージを送れます。

```powershell
pi install ./extensions/leafcode-intercom
```

設定は `%USERPROFILE%\.pi\agent\intercom\config.json` に記述します。`inboundTrigger` は `always`（既定）、`replies`、`never` を選べます。

同梱の15エージェントは `intercom` を許可し、子セッションでは `subagentOnlyExtensions` でプロバイダーを読み込みます。関連作業・編集競合があるときだけ `list` で相手のID・cwdを確認し、短い `send` で共有します。`ask` はブロック時のみ、親への判断依頼は `contact_supervisor`、通常の完了は結果返却のままです。受信内容を権限や承認として扱わず、秘密情報の送信・定期通知・無断pane起動はしません。

単体Piでも使う場合は上記パッケージを登録し、ツールを制限している `~/.pi/agent/settings.json` の `defaultTools` に `intercom` を追加して再起動してください。設定チェックは `node --test extensions/leafcode-subagents/intercom-config.test.mjs` で実行できます。

### 読み上げ (`leafcode-tts`)

`extensions/leafcode-tts` は Bot / エージェントの発言を読み上げます。既定は OFF で、`/tts`（`/tts on`・`/tts off`・`/tts test`）で切り替えます。設定画面から無効化できる唯一の `leafcode-*` 拡張です。

文章全体をまとめて渡さず、streaming の `text_delta` を「、」「。」「！」「？」と改行で短く区切り、合成と再生を並行させる Producer/Consumer 方式です。コードブロック・URL・Markdown 記法は読み上げません。サブエージェントの子プロセスでは無効です。

既定の合成は Windows 標準の SAPI（`System.Speech`）で、追加依存はありません。日本語は `Microsoft Haruka Desktop` が使えます。設定は `%APPDATA%\leafcode-pi\tts.json`（Linux/macOS は `~/.leafcode-pi/tts.json`）です。

```json
{
  "enabled": false,
  "voice": "Microsoft Haruka Desktop",
  "rate": 2,
  "url": ""
}
```

`url` を設定すると SAPI の代わりにその HTTP エンドポイントで合成します（`POST {"text": "...", "voice": "..."}` → wav バイト列）。Qwen3-TTS などをローカル GPU で動かす場合はこの口に繋ぎます。合成に失敗したチャンクは読み飛ばし、読み上げ全体は止めません。

```powershell
npx --prefix extensions/leafcode-todowrite vitest run --dir extensions/leafcode-tts
```

## まだないもの

OpenCode 版 LeafCode にあった worktree 分離、差分ペイン、Caddy は未実装です。権限の承認 UI（Composer のモード切替と SSE の簡易承認ダイアログ）は実装済みです。エージェントはプロジェクトフォルダ上で Pi の標準ツール（read / write / edit / bash / grep / find / ls）を直接実行します。`powershell` は Windows のみ既定で有効です。

## 動作条件

| 項目 | 要件 |
| --- | --- |
| OS | Windows 10/11 x64、または Linux/macOS |
| Node.js | 22.19 以上 |
| Pi 認証 | 設定画面のサブスクログイン（Claude Pro/Max / ChatGPT Plus/Pro）、環境変数、または `~/.pi/agent/auth.json` |
| Linux/macOS のプロセス検出 | `ss` または `lsof`、`ps`（WebUI の build guard / 停止に使用） |
| PowerShell（Windows のみ） | Pi 0.84.4 の標準ツール。`pwsh.exe` を優先し、なければ Windows PowerShell を使います |
| Bash（Linux/macOS） | Pi の標準シェルツール。Windows では必要時のみ明示的に有効化します |
| Linux のトレイ（任意） | グラフィカルセッションと systray 対応環境。既定はヘッドレスです |

## 起動

### Windows

リポジトリ直下の `start.bat` をダブルクリックします。初回は Node.js / 依存関係 / production build を確認し、トレイに常駐します。ソースがビルドより新しければ、本家 LeafCode と同じく起動時に `next build` し直します。準備できたら `http://127.0.0.1:3010` を開きます。

### Linux / macOS

`start.bat` は Windows 専用です。リポジトリ直下で次を実行します。`start.sh` は Node.js 22.19 以上を確認し、依存関係が無い場合だけ install してから WebUI と host を起動します。

```bash
chmod +x start.sh
./start.sh
```

手動で起動する場合は `npm --prefix web install`、`npm --prefix host install` の後に `npm run host` でも構いません。

Linux/macOS は既定でトレイを使わないため、SSH やヘッドレス環境でも起動できます。デスクトップのトレイを試す場合だけ `LEAFCODE_PI_TRAY=1 npm run host` を使います。ブラウザ自動起動は設定画面で有効にした場合のみ行われ、Linux は `xdg-open`、macOS は `open` を使います。

本番ビルドを使わず開発モードで起動する場合は `LEAFCODE_PI_MODE=dev npm run host` とします。`npm run dev` は WebUI だけを起動するため、host 制御 API や llama-server 連携は使いません。

本家 LeafCode と同じく、ホスト PC 上のブラウザが Tailscale / LAN IP で WebUI を開いた場合は `127.0.0.1` へ自動リダイレクトします（リモート端末はリダイレクトされません）。

ビルドが稼働中の `next start` の `.next` を置き換えたときは、そのままだと配信中の HTML が参照するチャンクが消えて `/_next/static/...` が 500 になり、キャッシュを持たないクライアント（スマホなど）に Next の "This page couldn't load" が出ます。`scripts/build-web.mjs` はビルド後に稼働中の WebUI を検出したら、ホスト制御の `POST /restart/webui` で新しい世代へ切り替えます。ホストに届かない場合はトレイの Restart WebUI が必要です。

Goal Loop は WebUI プロセス内で動くため、再起動するとセッション終了で必ず一時停止します。実行中の Goal Loop があるときは WebUI 再起動を拒否します（`POST /restart/webui` は 409、トレイの Restart WebUI と設定画面も同じ理由で拒否）。ループを停止・完了してから再起動してください。

production build は既存のミラー先を常設ビルド領域として直接使用します。Windows は **`%LOCALAPPDATA%\leafcode-pi\build\<checkout>-<hash>\`**、Linux/macOS は **`$XDG_CACHE_HOME/leafcode-pi/build/<checkout>-<hash>/`**（未設定時は `~/.cache/leafcode-pi/build/...`）で、`next start` も同じ場所から配信します。場所は従来どおり `LEAFCODE_PI_BUILD_DIR` で変更できます。

- `npm run build` と `npm --prefix web run build` は同じ入口を使います。稼働中の production WebUI を保護するため、手動ビルド前にトレイから終了してください。
- Next 16 はプロジェクト外の `distDir` を許可しないため、ソースの差分コピーだけを残します。OneDrive側の `node_modules` はビルド時に走査・同期・ハードリンクしません。
- 依存関係は初回または `package.json` / `package-lock.json` / Node.js環境の変更時に、ビルド領域で `npm ci --include=dev` します。旧ミラーも次回ビルドで移行するため、初回は依存インストールの時間・空き容量・ネットワーク接続が必要です。インストール失敗時は以前の依存関係を復元します。
- npm 12用に `web/package.json` の `allowScripts` で `better-sqlite3@12.9.0` のみを許可しています。依存インストール後はSQLiteの起動も検証します。SQLiteのバージョン更新時はこの許可も見直してください。
- `.next`・依存関係・ビルドキャッシュをOneDriveへ書き戻しません。`next dev` と開発用依存のインストール、起動時のPi自動更新は従来どおりリポジトリ側です。

トレイメニュー:

- Open browser
- 稼働状況
- Restart WebUI
- Quit（次回起動時に必要な production build があれば、先にビルドしてから終了）

```bat
start.bat
```

開発時に WebUI だけを動かす場合:

```powershell
npm --prefix web install
npm --prefix host install
npm run dev
```

コードの確認:

```powershell
npm --prefix extensions/leafcode-todowrite install --include=dev
npm run typecheck
npm run lint
npm test
# 上記をまとめて実行
npm run check
```

デスクトップショートカットは `scripts\create-shortcut.bat` です（`LeafCodePi.lnk`。LeafCode の `LeafCode.lnk` とは別ファイルです）。

プロジェクトデータ、ホストログ、`host.lock` は Windows では `%APPDATA%\leafcode-pi\`、Linux/macOS では `~/.leafcode-pi/` に保存します。Pi セッション本体は `~/.pi/agent/sessions/` です。トレイ用 TEMP は Windows では `%LOCALAPPDATA%\leafcode-pi\tmp`、Linux/macOS ではシステムの一時ディレクトリ配下です。

## LeafCode との同時起動

同じ Windows 上で [LeafCode](https://github.com/daihaya000/LeafCode) と並べて動かせます。既定値は重なりません。

| | LeafCode | LeafCodePi |
| --- | --- | --- |
| WebUI | `http://127.0.0.1:3000` | `http://127.0.0.1:3010` |
| 環境変数 | `LEAFCODE_*` | `LEAFCODE_PI_*` |
| データ | `%APPDATA%\leafcode` | Windows `%APPDATA%\leafcode-pi` / Linux `~/.leafcode-pi` |
| トレイ TEMP | `%LOCALAPPDATA%\leafcode\tmp` | Windows `%LOCALAPPDATA%\leafcode-pi\tmp` / Linux システム一時ディレクトリ |
| ショートカット | `LeafCode.lnk` | `LeafCodePi.lnk` |
| コンソール title | LeafCode | LeafCodePi |

`LEAFCODE_PORT` を LeafCodePi に渡しても読みません。ポートを変えるときは `LEAFCODE_PI_PORT` を使います。

## 構成

- `web/` — Next.js UI と BFF
- `host/` — Next.js の起動・監視・再起動。Windows はトレイ常駐、Linux/macOS は既定でヘッドレス
- `start.bat` — 導入とホスト起動
- `scripts/build-web.mjs` — production build の唯一の入口（ソース差分同期 → ローカル依存準備 → `next build` → BUILD_ID 検証）
- `scripts/web-build-mirror.mjs` — 既存のOneDrive外ビルド領域へのソース差分同期
- `extensions/` — Pi 拡張（Goal Loop、memory、subagents など）
- `docs/` — 実装計画と仕様
- `translation/` — 推論テキスト翻訳サービス
- `web/src/lib/pi/harness.ts` — Pi `createAgentSession` のプロセス内シングルトン
- `web/src/lib/store.ts` — プロジェクト / タスクの JSON ストア

## 環境変数

| 変数 | 内容 |
| --- | --- |
| `LEAFCODE_PI_DATA_DIR` | ストアと host.lock / host.log の保存先（未設定時は Windows `%APPDATA%\leafcode-pi`、Linux/macOS `~/.leafcode-pi`） |
| `LEAFCODE_PI_DEFAULT_DIR` | プロジェクト未登録タスクの作業ルート（未設定時は `~/Documents/LeafCodePi`） |
| `LEAFCODE_PI_PORT` | WebUI ポート（既定 **3010**。LeafCode の 3000 と衝突しない） |
| `LEAFCODE_PI_HOST` | WebUI 待ち受け。既定 `tailscale`（Tailscale IPv4。未検出時は 127.0.0.1）。`0.0.0.0` / 明示 IP も可 |
| `LEAFCODE_PI_HOST_CONTROL_PORT` | ホスト制御（llama-server 起動など）。既定 **18775**（LeafCode の 18765 と別） |
| `LEAFCODE_PI_LLAMA_PORT` | llama-server ポート。既定 **8081** |
| `LEAFCODE_PI_MODE` | `prod`（既定・start.bat）または `dev` |
| `LEAFCODE_PI_BUILD_DIR` | production build のミラー先（未設定時は Windows `%LOCALAPPDATA%\leafcode-pi\build\...`、Linux/macOS `$XDG_CACHE_HOME/leafcode-pi/build/...`） |
| `LEAFCODE_PI_EXTENSIONS_DIR` | 組み込み拡張のディレクトリ（host が自動設定） |
| `LEAFCODE_PI_SKILLS_DIR` | 組み込みスキルのディレクトリ（host が自動設定、既定はリポジトリの `skills/`） |
| `XDG_CACHE_HOME` | Linux/macOS の production build ミラー基底ディレクトリ |
| `LEAFCODE_PI_USE_WEBPACK` | `1` で `next build` を Turbopack でなく webpack で行う（切り分け用） |
| `LEAFCODE_PI_HEADLESS` | `1` でトレイなし |
| `LEAFCODE_PI_TRAY` | `1` で Linux/macOS のトレイを opt-in（グラフィカルセッションが必要） |
| `LEAFCODE_PI_NO_BROWSER` | `1` で起動時にブラウザを開かない |
| `LEAFCODE_PI_NONINTERACTIVE` | `1` で失敗時の pause を省略 |
| `LEAFCODE_PI_LLAMA_SERVER_BIN` | Linux/macOS の llama-server バイナリ（未設定時は PATH の `llama-server`） |
| `LEAFCODE_PI_LLAMA_MODEL_DIR` | Linux/macOS のモデルディレクトリ（未設定時は `~/models/llm`） |
| `ANTHROPIC_API_KEY` など | Pi が読むプロバイダーキー |


## Bot mode

LeafCodePi also provides a small Bot mode for named 1:1 assistants. Use the Code/Bot switch in the sidebar, create a bot under `/bots`, and edit its `SOUL.md` on the bot page. Bot homes live under the existing data directory (`%APPDATA%\leafcode-pi\bots` on Windows, `~/.leafcode-pi/bots` elsewhere); tools run in each bot's `workspace/`. Bots can use the bundled `intercom` tool to coordinate with other local Pi sessions; it is enabled for newly created bots and can be toggled under **使用するツール**. Rooms are available separately; routines can be created from a bot settings panel. Routines are stored under `bots/<botId>/routines/`, run as the bot in its workspace, and post results to that bot's 1:1 thread. The cron scheduler runs only while the web app process is running (opening a bot routine panel starts it); it enforces a five-minute minimum interval, a ten-routine enabled limit, and disables a routine after three consecutive failures.
