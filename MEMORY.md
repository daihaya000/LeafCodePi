# MEMORY

## 2026-08-20: LeafCodePi MVP を新規構築

OpenCode 版 LeafCode（`C:\Users\Daichi\OneDrive\AI\OpenCode\LeafCode`）の UI/UX 骨格を維持した、Pi Coding Agent 向け最低限フロントエンドをこのリポジトリに追加した。

### 方針

- OpenCode / `opencode serve` / トレイホストは使わない。
- `@earendil-works/pi-coding-agent` の SDK（`createAgentSession` + `ModelRuntime`）を Next.js BFF に埋め込む。
- 見た目は LeafCode と同じトークン（`--bg` / Geist / GhostSelect / composer カード / サイドバー）。
- MVP の範囲: プロジェクト追加、ホーム composer、タスクタイムライン + SSE、モデル選択、設定のエンジンタブ。

### 構成

- `web/` — Next.js 15.5 + React 19
- `web/src/lib/pi/harness.ts` — プロセス内シングルトン。タスクごとに AgentSession を保持し、prompt は HTTP を待たせず SSE で流す
- `%APPDATA%\leafcode-pi\store.json` — プロジェクト / タスクメタ
- Pi セッション本体は `~/.pi/agent/sessions/`

### 検証

- `npx vitest run` — 4 passed
- `npx tsc --noEmit` — 成功
- `npx next build` — 成功（API はすべて dynamic）

### 残存（意図的に未実装）

- worktree / 一時コピー、権限カード、差分ペイン、ゴールループ、ホストトレイ、Caddy、ログイン
- Pi の bash は Windows で Git Bash などが必要
