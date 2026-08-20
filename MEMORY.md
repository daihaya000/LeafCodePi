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

- `scripts/llama-server-load.bat` — ポート **8080**。`MODEL_FILE` あり → `-m` 単体、空 → `--models-dir` ルーター
- `host/src/llama-server-service.js` + トレイ + 制御プレーン **:18775**（`host-control.json`）
- WebUI「エンジン」タブに起動・停止・パス設定

### Pi 側

- `registerNativeProvider(createLlamaProvider())` — ID `llama.cpp`（ルーター）
- `registerProvider("llama-server")` — OpenAI 互換・単体モデル（設定の GGUF 名）
- 設定: `%APPDATA%\leafcode-pi\settings\llama-server-config.json`

### 注意

クライアントの `LlamaServerSettings` は `node:fs` 付きの `host-control` を import しない（`loopback.ts` に分離）。Webpack の UnhandledSchemeError 防止。
