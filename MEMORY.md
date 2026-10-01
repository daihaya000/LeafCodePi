# LeafCodePi FE/BE 分離パフォーマンス改善 (2026-10-02)

対象: 分離後に増えた定常負荷（SSE poll・pending 全件・サイドバー cold 走査・health SDK 温め・Host 毎回 bundle）と、残本丸（dirty push・履歴射影削減）。

## 修正済み

### サイドバー cold SessionManager 走査を client で停止

- `getTaskSummariesWithTodoProgress` / `getBotCodeSessionPanelState`
- `localRuntimeBlocked()` 時は Todo 用に cold session を開かない（Goal Loop はディスクのみ継続）

### pending-snapshots のプロセス内共有

- `forwardTaskPendingRequests` / `forwardPendingRequestsByTask` が同一 in-flight GET を共有

### リモート SSE: idle omit + messageRevision

- 初回と streaming/compacting は `messages=page`
- idle は `messages=omit`。`messageRevision` 不変なら前回 page の messages を再利用
- revision 変化時のみ page を追加取得（Backend のフル履歴射影を回避）
- in-flight coalesce キーは `${taskId}:${page|omit}`

### Backend→Web task_dirty push

- harness `publishTaskDirty`（50ms coalesce）。`emitTaskSnapshot` は listener 無しでも dirty を出す。delta は出さない（streaming は 2s page poll）
- `subscribeTaskDirty` を runtime entry / loader 必須 export に追加
- `/internal/runtime/events` が `task_dirty` を配信
- Web `backend-task-dirty-hub` がプロセス内で 1 本の SSE を共有し、taskId ごとに wake
- dirty 購読中の idle 安全網は 30s（`BACKEND_EVENT_DIRTY_IDLE_POLL_MS`）。未接続時は 5s

### client `/api/health` が Pi SDK / listModels を温めない

- `localRuntimeBlocked()` なら ensureRuntime を呼ばない

### Backend runtime bundle の stamp 再利用

- fingerprint 一致時に esbuild をスキップ（`--force` で再ビルド可）

## 意図的にまだやらない

- フル delta 中継（Backend per-task SSE）— dirty+page で十分な即時性
- HTTP 304 / ETag（クライアント revision 比較で代替）
- サイドバー summary の Backend 側 todoProgress 提供

## 検証

- web: backend-event-stream 31 / backend-task-dirty-hub 1 / backend-forward 50 / tasks events route 19 pass
- backend: runtime-events / runtime-loader / server.test 76 pass
- `node scripts/build-backend-runtime.mjs --force` で subscribeTaskDirty を bundle に反映
