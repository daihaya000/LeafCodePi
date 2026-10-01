# LeafCodePi FE/BE 分離 バグ潰し / パフォーマンス (2026-10-02)

## 本ターンで追加した修正

### Prompt 配送リコンサイル（バグ）

- `ApiError` が `code` / `reason` を伝播（`BACKEND_FORWARD_FAILED` 判定に必要）
- `prompt-delivery.ts`: transport 失敗のみ reconcile、明示拒否はエラーのまま
- TaskView / BotView: 失敗時に `{ task }` + `messages=page` で受け取り済み user を確認し、誤って下書き復元しない
- `GET /api/tasks/[id]` が `messages=page|omit` を Backend に転送

### Room pending soft-fail（バグ）

- `forwardPendingRequestsByTask` が `ok: false` を返す（空マップで attention を消さない）
- Room events は失敗時に前回 map を保持

### Room dirty + poll 間隔（perf）

- Room events が `subscribeBackendTaskDirty` で即 refresh
- Backend 所有時の安全網 poll を 5s に延長（本地 2s のまま）

### peekCodeRequestProgress cold 開き停止（perf）

- `localRuntimeBlocked()` 時は Pi cold open しない

### startup warmModels（perf）

- cutover 後は `listModelsForAccounts` を呼ばない

## 既存（前回まで）

- サイドバー cold Todo 走査停止、pending 共有、omit+revision、task_dirty push、health ensureRuntime skip、bundle stamp

## まだ残る本丸

- Code requests / code-session の Backend 進捗 enrich
- GlobalAttention の dirty 化
- サイドバー summary の Backend todoProgress
- フル delta 中継（意図的 defer）

## 検証

- prompt-delivery 2 / backend-forward 50 / rooms events 6 / backend-event-stream 31 / dirty-hub 1 / tasks events 19 pass
