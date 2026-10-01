# LeafCodePi FE/BE 分離バグ潰し (2026-10-01)

対象: Web(Next.js BFF) ↔ Backend ↔ Host の API / SSE / 依存同期 / ミラー / 再起動境界。

## 修正済み

### P0 — Bot prompt が業務エラー envelope を破棄して 200 化

- 場所: `web/src/app/api/bots/[id]/prompt/route.ts`
- 修正: `forwarded.result` を task prompt と同様に replay。4xx `bad-response` も保全。
- 回帰: `bots/[id]/prompt/route.test.ts`（result envelope / 4xx）

### P1 — Task SSE が pending 失敗で承認 UI を null 上書き

- 場所: `web/src/lib/backend-forward.ts` + `web/src/lib/pi/backend-event-stream.ts`
- 修正: pending 失敗は `{ ok: false }`。ストリームは直前の pending を保持。
- 回帰: `backend-forward.test.ts` / `backend-event-stream.test.ts`

### P1 — タスク作成 409 が Web で 502 に潰れる

- 場所: `web/src/app/api/tasks/route.ts`
- 修正: 保全 status に 409 を追加。
- 回帰: `tasks/route.test.ts`

### 高 — ミラー内 `.leafcode-pi-deps.lock` が prune されず毎起動 stale rebuild

- 場所: `scripts/web-build-mirror.mjs` / `shared/pi-dependencies.mjs` / `host/src/index.js`
- 修正: ミラー prune で `.leafcode-pi-*` を削除。ミラー版ゲートは `requireUnlocked: false`。
- 回帰: `web-build-mirror.test.js` / `isolation.test.js`

### 高 — worker タイムアウト時に kill 成否を見ずに lock 削除

- 場所: `host/src/pi-update.js`
- 修正: `isAlive` で死亡確認後のみ lock 削除。生存時は lock 維持して二重同期を防ぐ。
- 併せて cleanup 予算を 180s に拡大（README の「後始末除外」に整合）。
- 回帰: `pi-update.test.js`

### 中 — restart-guard の health 期限ハードコード

- 場所: `host/src/runtime-restart-guard.js`
- 修正: `timeoutMs` 引数で health / control の期限を揃える。`init.signal` 欠落時の TypeError も回避。

### P2 — アカウント削除/停止の hang 監視が client Web で空振り

- 場所: `web/src/lib/pi/hang-watchdog.ts` `getTaskHangWatch`
- 修正: production client（`localRuntimeBlocked`）では共有 `hang-watches.json` を読む。
- 回帰: `hang-watchdog.test.ts` / `accounts.test.ts`

## 既知の残リスク（未修正）

なし（調査時点で証拠付きの分離境界バグは対応済み）。

## 検証

- host: pi-update / web-build-mirror / isolation / runtime-restart-guard → pass
- web vitest: backend-event-stream / backend-forward / tasks route / bot prompt / events → 165 pass
- web vitest: hang-watchdog / accounts → 57 pass
- backend: sdk-dependency-versions + lease 関連 → pass
