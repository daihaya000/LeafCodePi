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
- 既定: `LEAFCODE_PI_HOST=127.0.0.1`、`LEAFCODE_PI_PORT=3010`、`LEAFCODE_PI_MODE=prod`。
- `.next/BUILD_ID` が無ければ `next build`。失敗時は `next dev` にフォールバック。
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

- worktree / 一時コピー、権限カード、差分ペイン、ゴールループ、Caddy、ログイン、ネイティブ exe ランチャー
- Pi の bash は Windows で Git Bash などが必要
- トレイアイコン画像は LeafCode と同じ葉。ツールチップは LeafCodePi Host
