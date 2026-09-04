# MEMORY

## 2026-09-05 — Codex 使用量リセット権 UI

ChatGPT Codex の banked rate-limit reset（リセット権）を CodexBar から確認付きで消費できるようにした。

### 要点
- `/wham/usage` の `rate_limit_reset_credits.available_count` を `CodexBarProvider.resetCreditsAvailable` に載せる
- BFF: `GET/POST /api/codexbar/reset-credits`（WHAM list/consume、アカウント単位 OAuth）
- UI: Codex 行の展開時に「リセット権 N」「使う」→ confirm → consume → usage 再取得
- 自動消費はしない（不可逆のため手動確認のみ）

### 主要ファイル
- `web/src/lib/codexbar/providers/openai-codex.ts` — usage パース + WHAM auth 解決
- `web/src/lib/codexbar/providers/openai-codex-reset.ts` — list/consume アダプタ
- `web/src/app/api/codexbar/reset-credits/route.ts` — BFF
- `web/src/components/codexbar/CodexBarWidget.tsx` — UI
