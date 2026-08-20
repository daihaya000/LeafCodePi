# MEMORY

## 2026-08-20: LeafCodePi MVP を新規構築

OpenCode 版 LeafCode（`C:\Users\Daichi\OneDrive\AI\OpenCode\LeafCode`）の UI/UX 骨格を維持した、Pi Coding Agent 向け最低限フロントエンドをこのリポジトリに追加した。

### 方針

- OpenCode / `opencode serve` は使わない。
- `@earendil-works/pi-coding-agent` の SDK（`createAgentSession` + `ModelRuntime`）を Next.js BFF に埋め込む。
- 見た目は LeafCode と同じトークン（`--bg` / Geist / GhostSelect / composer カード / サイドバー）。
- MVP の範囲: プロジェクト追加、ホーム composer、タスクタイムライン + SSE、モデル選択、設定のエンジンタブ。

### 構成

- `web/` — Next.js 15.5 + React 19
- `web/src/lib/pi/harness.ts` — プロセス内シングルトン。タスクごとに AgentSession を保持し、prompt は HTTP を待たせず SSE で流す
- `%APPDATA%\leafcode-pi\store.json` — プロジェクト / タスクメタ
- Pi セッション本体は `~/.pi/agent/sessions/`

## 2026-08-20: start.bat とタスクトレイ常駐

`start.bat` → `scripts/start-webui.bat` → `host/src/index.js`（systray2）で Next.js を起動し、通知領域に常駐する。

### 起動

- bat は ASCII / CRLF / BOM なし。日本語は `scripts/setup-messages/*.txt`（UTF-8 CRLF）を `chcp 65001` 後に `type`。
- 既定: `LEAFCODE_PI_HOST=tailscale`、`LEAFCODE_PI_PORT=3010`、`LEAFCODE_PI_MODE=prod`。
- `tailscale` は NIC 名 Tailscale または CGNAT `100.64.0.0/10` の IPv4 にバインド。未検出時は `127.0.0.1`。ブラウザ/ヘルスは `0.0.0.0` を使わず `publicHost` 経由。
- `.next/BUILD_ID` が無ければ `next build`。ソース（`web/src` など）が BUILD_ID より新しければ stale として再ビルド（本家 LeafCode と同じ）。
- stale 再ビルド失敗時は既存の production build を継続。完全欠落時のみ `next dev` にフォールバック。
- トレイ: Open browser / 稼働状況 / Restart WebUI / Quit。OneDrive 上の TEMP 回避のため起動時だけ `%LOCALAPPDATA%\leafcode-pi\tmp`。
- 二重起動は `%APPDATA%\leafcode-pi\host.lock`。死んだ PID なら stale として削除。
- `node src\index.js` の相対 argv は `host/src/entry.js` の `resolve()` で判定。
- デスクトップショートカットは `scripts/create-shortcut.bat` → `LeafCodePi.lnk`。

### LeafCode との同時起動（衝突回避）

| | LeafCode | LeafCodePi |
| --- | --- | --- |
| WebUI | :3000 | :3010 |
| 環境変数 | `LEAFCODE_*` | `LEAFCODE_PI_*` |
| データ / lock / log | `%APPDATA%\leafcode` | `%APPDATA%\leafcode-pi` |
| トレイ TEMP | `%LOCALAPPDATA%\leafcode\tmp` | `%LOCALAPPDATA%\leafcode-pi\tmp` |
| ショートカット | `LeafCode.lnk` | `LeafCodePi.lnk` |
| title | LeafCode | LeafCodePi |

LeafCode 側の制御ポート 18765 / broker 18766 / OpenCode 4096 は使わない。

### 検証

- `npm --prefix host test` — 19 passed（bat エンコーディング、起動プラン、隔離）
- ヘッドレススモーク: `LEAFCODE_PI_HEADLESS=1` `LEAFCODE_PI_NO_BROWSER=1` `LEAFCODE_PI_PORT=3010` で `GET /api/health` 200、dataDir は指定の TEMP

### 残存（意図的に未実装）

- worktree / 一時コピー、権限カード、差分ペイン、ゴールループ、Caddy、ネイティブ exe ランチャー
- Pi の bash は Windows で Git Bash などが必要
- トレイアイコン画像は LeafCode と同じ葉。ツールチップは LeafCodePi Host

## 2026-08-20: OpenAI / Anthropic サブスクログイン

設定画面から Pi の OAuth を起動できるようにした。

- Anthropic → Claude Pro/Max（`oauth`）
- OpenAI Codex → ChatGPT Plus/Pro（`openai-codex` / `oauth`）
- BFF: `POST /api/providers/:id/login` + SSE events + answer/cancel、`POST .../logout`
- 認証情報は `~/.pi/agent/auth.json` に保存（OpenCode の auth とは別）
- 検証: `vitest` 7 passed、`tsc --noEmit` 成功

## 2026-08-20: start.bat で stale production を再ビルド

本家 LeafCode と同様、`start.bat` → host 起動時に `isWebBuildStale(web, web/.next)` を見てソースが新しければ `next build` する。

- `getWebLaunchPlan(mode, hasBuild, buildStale)`
- stale 再ビルド失敗時は既存 BUILD_ID を継続
- bat は「Existing build found; host will rebuild if sources are newer.」を表示

## 2026-08-21: 設定「モデル」タブ（有効・無効・並び替え）

本家 LeafCode のモデルタブから、プロバイダー/モデル一覧だけを移植。

- 状態: `%APPDATA%\leafcode-pi\provider-model-state.json`（disabled / providerOrder / modelOrder）
- API: `GET/PATCH /api/provider-models`, `PATCH .../order`, `PATCH .../[key]`
- `/api/models` とヘルスの modelCount は有効なものだけ
- デフォルトモデル / 価格 / アイコン / Auto は未移植

## 2026-08-21: タスク画面のモデル切替が効かない不具合

### 原因

`TaskView` が `POST /api/tasks/:id/model` の結果をローカル state に反映していなかった。ドロップダウンは `task.providerID::modelID` の制御コンポーネントのため、選択直後に旧値へ戻って見えた。加えて SSE マージが `messages: undefined` で上書きしうる形だった。

### 修正

- レスポンスの `task` で state を更新
- `setTaskModel` 後に SSE snapshot を送る
- snapshot マージで既存 messages を保持

## 2026-08-21: Tailscale にバインド

`start.bat` 既定の `LEAFCODE_PI_HOST` を `tailscale` にした。

- `findTailscaleIPv4()`: NIC 名に Tailscale、なければ `100.64.0.0/10`
- 未検出時は `127.0.0.1` にフォールバック（ログで案内）
- ブラウザ / ヘルス URL は `publicHost`（`0.0.0.0` は使わない）
- ローカルのみ: `LEAFCODE_PI_HOST=127.0.0.1` / 全 IF: `0.0.0.0`

## 2026-08-21: llama.cpp (llama-server) 対応

本家 LeafCode の起動制御を移植し、Pi の推論プロバイダーも配線した。

### ホスト

- `scripts/llama-server-load.bat` — ポート **8081**（LeafCode と共有）。`MODEL_FILE` あり → `-m` 単体、空 → `--models-dir` ルーター
- `host/src/llama-server-service.js` + トレイ + 制御プレーン **:18775**（`host-control.json`）
- WebUI「エンジン」タブに起動・停止・パス設定

### Pi 側

- `registerNativeProvider(createLlamaProvider())` — ID `llama.cpp`（ルーター）
- `registerProvider("llama-server")` — OpenAI 互換・単体モデル（設定の GGUF 名）
- 設定: `%APPDATA%\leafcode-pi\settings\llama-server-config.json`

### モデル ID

スタブ `local` は使わない。`GET http://127.0.0.1:8081/v1/models` の id を `listModels` 時に同期する。単体起動 bat は `--alias <gguf名>` を付与。

### 起動時ロード

ルーター起動でモデルが `unloaded` のまま残らないよう、`--no-models-autoload` を外し、bat / UI 起動後に `scripts/llama-server-ensure-loaded.mjs` と `POST /api/llama-server/ensure-loaded` で `/models/load` する。

## 2026-08-21: Cursor サブスク対応

`@rahularya01/pi-cursor` を Web 依存に追加し、`ModelRuntime` 起動時に拡張をロードしてプロバイダー ID `cursor` を登録。

- 設定 → モデル → サブスク一覧にハイライト表示（`SUBSCRIPTION_PROVIDER_IDS`）
- OAuth: 既存の `/api/providers/:id/login` フロー（ブラウザ PKCE）
- Cursor IDE / CLI ログイン済みならトークン自動検出の場合あり
- 非公式拡張。Node 22.19+ 推奨

## 2026-08-21: プロバイダアイコン

本家 LeafCode の `web/public/icons/*` を移植。`providerIconSrc()` + `ProviderIcon` をモデル選択・設定・タイムラインに表示。

### 注意

クライアントの `LlamaServerSettings` は `node:fs` 付きの `host-control` を import しない（`loopback.ts` に分離）。Webpack の UnhandledSchemeError 防止。

## 2026-08-21: 設定に再起動ボタン

設定 → エンジンに「再起動」セクションを追加。トレイの Restart WebUI と同じ経路。

- ホスト制御: `POST /restart/webui`・`POST /restart/host`（:18775、202 後に実行）
- BFF: `POST /api/host/restart`（`target: webui | host`）
- UI: `HostRestartPanel`（確認ダイアログ → ヘルス待ち）
- ホスト全体再起動は lock 解放待ち bat を WMI で起動してから `quit()`

## 2026-08-21: サブスクと有効モデル一覧をモデルタブへ

設定のプロバイダー認証とモデル一覧をエンジンからモデルタブへ移動。エンジンはヘルス / llama-server / 再起動のみ。

## 2026-08-21: 設定ラベル整理

モデルタブ見出しを「プロバイダー」「モデル」に統一。

## 2026-08-21: llama-server 設定のデザイン統一

エンジンタブのローカル LLM セクションを他カード（`rounded-2xl` / `bg-surface` / `h2`）と同じ文脈に揃える。

## 2026-08-21: llama-server Qwen3 effort 切替

`Qwen3.8-27B-Uncensored-GGUF` など Qwen3 系 GGUF で ThinkingSelect が効くようにする。

- モデルを `reasoning: true`、対応レベル `off/low/medium/xhigh`
- リクエスト書換: 段階 effort → `chat_template_kwargs.reasoning_effort`、off → トップレベル `none` + `/no_think`
- （GGUF テンプレは kwargs に `none` を入れると 500 になる）

## 2026-08-21: effort 非対応モデルは ThinkingSelect 非表示

effort オプションがないモデルでは「思考なし」固定表示も含めドロップダウンを出さない。

## 2026-08-21: llama-server モデル表示名

表示名を `llama-server (Qwen…)` から GGUF 名のみ（例: `Qwen3.8-27B-Uncensored-GGUF`）に変更。

## 2026-08-21: グローバル AGENTS.md（カスタム指示）

設定 → 一般に `~/.pi/agent/AGENTS.md` の編集 UI を追加（プロジェクト単位は未対応）。

- `GET/PATCH /api/agents-md`
- 2MB 上限、シンボリックリンク拒否
- 保存後 `reloadLiveSessionsContext()` で開いている AgentSession に Pi `/reload` 相当を実行（即時反映）

## 2026-08-21: Ollama Cloud プロバイダ

`https://ollama.com/v1`（OpenAI 互換）をプロバイダー ID `ollama-cloud` として登録。

- API キー: 設定画面ログイン、または `OLLAMA_API_KEY`
- モデル一覧は認証後に `/v1/models` から取得
- 設定の推奨枠にハイライト表示

## 2026-08-21: コンテキスト使用量表示

タスク画面ヘッダーに Pi `session.getContextUsage()` のバーを表示。

- `TaskDetail.contextUsage` + SSE snapshot で即時更新
- 使用率 70% で warning、90% で danger 色
- 圧縮直後など tokens 不明時は `?` 表示

## 2026-08-21: モデル別 effort（思考レベル）切替

Pi の `getSupportedThinkingLevels` / `setThinkingLevel` に合わせ、モデルが受け付けるレベルだけを UI に出す。

- `ModelOption.thinkingLevels` を `/api/models` に付与
- ホーム / タスクの `ThinkingSelect`（非対応モデルは「思考なし」固定）
- `POST /api/tasks/:id/thinking` でライブセッションへ即時反映
- タスク作成・モデル切替時に clamp

## 2026-08-21: コンテキスト圧縮

Pi `session.compact()` / 自動圧縮設定に対応。

- タスクヘッダー「圧縮」→ `POST /api/tasks/:id/compact`（最大 240s、キャンセルは `/compact/abort`）
- SSE に `isCompacting`、要約は `compactionSummary` → UI の圧縮カード
- 設定 → 一般で自動圧縮 ON/OFF（`~/.pi/agent/settings.json` の `compaction.enabled`、ライブセッションへ即反映）
- 閾値は Pi 既定（reserveTokens / keepRecentTokens）

