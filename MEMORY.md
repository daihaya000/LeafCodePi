# LeafCodePi FE/BE 分離 バグ潰し / パフォーマンス (2026-10-02)

## 本ターンで追加した修正

### Room SSE: dirty 落ち＋本文の pending 待ちを潰す（正しさ / 遅延）

- 証拠: `getRoom()` / `RoomFileStore.readRoom` は常にディスク直読（キャッシュ無し）。dirty は既に `snapshot()` を呼ぶ。
- 問題1: `pendingBusy` 中の dirty wake が捨てられ、次の 5s 安全網まで本文・attention が遅延。
- 問題2: cutover 時 `forwardPendingRequestsByTask` の HTTP 完了まで `getRoom` 結果を送らず、ディスク上の新メッセージも pending RTT 分遅延。
- 修正: dirty 中は `dirtyQueued` で再実行。ディスクを先に読んで last-known attention で即 emitし、pending 後に再読込して再 emit。dirty 購読中は安全網を 5s→2s。
- テスト: disk-first / dirty queue / 既存 soft-fail・serialize を更新（rooms events 8）。

### Sidebar: task_dirty wake + idle 延伸（perf）

- GlobalAttention と同様に `/api/bots/events` の `task_dirty` で即 refresh。
- dirty 接続時の idle ポーリングを 12s→20s（working 中は 4s のまま）。
- 非 working 全件向け Backend summaries / N×omit は未着手（stampede 回避方針は維持）。

### build-backend-runtime 整合（確認のみ）

- `backend-runtime-entry` と `REQUIRED_RUNTIME_EXPORTS` に `subscribeTaskDirty` あり。activity 付き omit は実機で `npm run build:backend-runtime` が必要（前回どおり）。

## 既存（前回まで / 9972b44d）

- Code activity の omit enrich、Room の死んだ subscribeTask 停止
- todoProgress omit / GlobalAttention dirty、prompt reconcile、SSE omit/revision 等

## まだ残る本丸

- サイドバー非 working 向け Backend summaries（または安い batch）— 現在は working / goal-loop のみ omit
- フル delta 中継（意図的 defer；小さい勝ちを優先）
- Room: Backend が delta のみで room ファイルを更新し dirty が無い区間は最大 2s 安全網（dirtyQueued / disk-first で busy 落ちと pending 待ちは解消）
- cutover 実機では `npm run build:backend-runtime` で activity 付き omit を Backend バンドルへ載せる必要あり

## 検証

- rooms events 8 / room-events / backend-task-dirty-hub / Sidebar.test + SidebarProgress pass
- Push していない
