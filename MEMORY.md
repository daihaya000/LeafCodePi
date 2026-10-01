# LeafCodePi FE/BE 分離 バグ潰し / パフォーマンス (2026-10-02)

## 本ターンで追加した修正

### Backend omit で todoProgress を補完（正しさ + perf）

- `remote-todo-progress.ts`: `forwardTaskDetail(..., messages=omit)` + in-flight 共有 / 並列上限
- `peekCodeRequestProgress`: cutover 時は cold Pi の代わりに omit enrich
- `getTaskSummariesWithTodoProgress` / `getBotCodeSessionPanelState`: working（± goalLoop）のみ omit enrich

### GlobalAttention dirty wake（perf）

- `/api/bots/events` の `task_dirty` で即 attention 再取得
- dirty 接続中の安全網は 15s（未接続時は従来 4s）
- `pollBusy` / `pendingWake` で wake 取りこぼしを抑制

## 既存（前回まで / f106b8e8 以前）

- Prompt 配送リコンサイル（ApiError code/reason、TaskView/BotView）
- Room pending soft-fail 保持、Room dirty + 5s 安全網
- peek cold 開き停止、warmModels ガード
- サイドバー cold Todo 走査停止、pending 共有、omit+revision、task_dirty push、health skip、bundle stamp

## まだ残る本丸

- Code session / activity の専用 Backend enrich（todo 以外）
- サイドバー全件向け Backend summaries API（現在は working のみ omit）
- フル delta 中継（意図的 defer）

## 検証

- remote-todo-progress 4 / GlobalAttention 26 / prompt-delivery 2 / client 5 / backend-forward 50 / backend-event-stream 31 / dirty-hub 1 / rooms events 6 / code-requests 3 / TaskView delivery 6 pass
- Push していない
