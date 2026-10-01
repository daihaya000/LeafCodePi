# LeafCodePi FE/BE 分離パフォーマンス改善 (2026-10-02)

対象: 分離後に増えた定常負荷（SSE poll・pending 全件・サイドバー cold 走査・health SDK 温め・Host 毎回 bundle）。

## 修正済み

### サイドバー cold SessionManager 走査を client で停止

- `getTaskSummariesWithTodoProgress` / `getBotCodeSessionPanelState`
- `localRuntimeBlocked()` 時は Todo 用に cold session を開かない（Goal Loop はディスクのみ継続）
- 分離後は全タスクが cold 扱いになり、4–12 秒 poll ごとに秒単位の再解析が走っていた

### pending-snapshots のプロセス内共有

- `forwardTaskPendingRequests` / `forwardPendingRequestsByTask` が同一 in-flight GET を共有
- 開いている Task/Bot/Room SSE 数ぶんの全件取得を1本に畳む

### リモート SSE のアイドル poll 間隔を 5s に伸ばす

- `BACKEND_EVENT_IDLE_POLL_MS = 5000`（streaming/compacting 中は従来の 2s）
- アイドル時のフル detail 投影頻度を約 2.5 倍削減

### client `/api/health` が Pi SDK / listModels を温めない

- `rebuildHealth` が `localRuntimeBlocked()` なら ensureRuntime を呼ばない
- Sidebar の health poll が ~250ms の catalog 再構築を起こさない

### Backend runtime bundle の stamp 再利用

- `scripts/build-backend-runtime.mjs` がソース fingerprint 一致時に esbuild をスキップ
- Host 起動の毎回フルバンドルを回避（`--force` で再ビルド可）

### 予備 API: `messages=omit`

- Backend detail が `includeMessages: false` を受け付ける（将来の軽量 poll 用）
- 現 SSE は correctness のため page のまま。`messageRevision` を live snapshot に付与

## 意図的にまだやらない（大きいが本丸）

- Backend→Web のイベント push 中継（計画書どおり「即時配信 vs 2s poll」）
- poll 時のフル履歴射影そのものの削減（revision/304）
- サイドバー summary の Backend 側 todoProgress 提供

## 検証

- web: backend-event-stream 27 / backend-forward 50 pass
- backend: server.test 76 pass
- scripts: build-backend-runtime.test.mjs（stamp）
