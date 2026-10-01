# LeafCodePi 境界バグ調査 (2026-10-01)

対象: Web(Next.js BFF) ↔ Backend ↔ Host の API / SSE / lease / restart 分離。
除外（既知）: mirror deps.lock prune / pi-update kill+lock / worker 後始末予算 / restart-guard 二重 deadline。

## 優先度付きバグ

### P0 — Bot prompt が Backend 業務エラー envelope を破棄し 200 化する

- 場所: `web/src/app/api/bots/[id]/prompt/route.ts`（`forwardTaskPrompt` 成功分岐）
- 対照: `web/src/app/api/tasks/[id]/prompt/route.ts` は `forwarded.result` を replay
- Backend: `backend/src/server.mjs` が `{ result: { status, body } }` を HTTP 200 で返す
- Forward: `web/src/lib/backend-forward.ts` `forwardTaskPrompt` が `result` を返す
- 実害: Bot 送信の 409 等（例: 停止直後再試行拒否）が `{ task: null }` の 200 になり、UI が成功扱い
- 証拠: 同一入力で task 経路は 409、bot 経路は 200 になる最小スクリプトで確認。既存 bot prompt テストは `result` ケース無し

### P1 — Task SSE の pending ソフト失敗が承認/質問を null で上書き

- 場所: `web/src/lib/backend-forward.ts` `forwardTaskPendingRequests`（失敗→両方 null）
- 消費: `web/src/lib/pi/backend-event-stream.ts`（detail 成功時に pending をそのまま send）
- 実害: pending-snapshots の一瞬の失敗で permission/question が消え、再取得まで承認 UI が消える
- 証拠: soft-fail→null 送信の最小再現で確認。detail 失敗はスキップするが pending 失敗はスキップしない非対称

### P1 — タスク作成の 409 が Web で 502 に潰れる

- 場所: `web/src/app/api/tasks/route.ts`（許可 status: 400/404/413/422 のみ、409 欠落）
- Backend: `createTask` 例外は `error.status` を HTTP に載せ `code: internal`（`backend/src/server.mjs`）
- Client: 409+internal は `bad-response`+status 409（`web/src/lib/backend-client.ts`）
- 実害: アーカイブ中・競合などの 409 が輸送失敗 502 になり、再試行/メッセージが誤る

### P2 — アカウント削除/停止の hang 監視が client Web で常に空

- 場所: `web/src/lib/accounts.ts` `assertAccountIdleForDisable` → `getTaskHangWatch`
- Hang: `web/src/lib/pi/hang-watchdog.ts` `shouldRunHangWatchdog` は `!localRuntimeBlocked`（production client では未起動）
- 実害: hang abort→idle→resume の隙間で、Backend が復旧中でも Web からアカウント削除/停止が通る可能性
- lease/`working`/Goal Loop ディスク状態は共有のため一部は防げるが、コメントが想定する hang watch ガードは client では無効

## 実行した検証

- `vitest`: bot prompt / backend-event-stream / lease-owner（59 pass）
- `node --test`: file-lock / lease-reclaim / directory-lock（19 pass）
- `node --test`: host isolation + runtime-restart-guard（24 pass）
- 既知4件および WIP（pi-update / mirror）は本報告から除外

## 修正方針（未着手）

1. Bot prompt を task prompt と同様に `forwarded.result` replay + 4xx 保全
2. SSE は pending 失敗時に前回 pending を維持（または detail と同様スキップ）
3. create-task 許可 status に 409 を追加（必要なら元メッセージも転送）
4. アカウント無効化は Backend に問い合わせるか、共有 hang-watch 永続を参照
