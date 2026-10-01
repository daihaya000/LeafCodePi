# LeafCodePi FE/BE 分離 バグ潰し / パフォーマンス (2026-10-02)

## 本ターンで追加した修正

### Code activity の omit enrich（正しさ）

- `sessionSnapshotFields`: `messages=omit` でも latestOnly 投影で `activity`（実行中ツールラベル）を付与
- `remote-todo-progress.ts`: `fetchRemoteCodeProgress` で Todo + activity を同一 omit GET で共有
- `peekCodeRequestProgress`: cutover 時は live が無いため remote activity を返す（従来は Todo のみ補完で activity 欠落）

### Room SSE の死んだ subscribeTask を停止（perf）

- Backend 所有時はローカル `subscribeTask` を張らず、dirty + ディスク再読取の安全網だけにする

## 既存（前回まで / de49dc90）

- Backend omit で todoProgress 補完（peek / sidebar working / Code panel）
- GlobalAttention dirty wake（15s 安全網）
- Prompt 配送リコンサイル、Room pending soft-fail、peek cold 停止、warmModels ガード
- サイドバー cold Todo 走査停止、pending 共有、omit+revision、task_dirty push、health skip、bundle stamp

## まだ残る本丸

- サイドバー全件向け Backend summaries API（現在は working のみ omit）
- フル delta 中継（意図的 defer）
- Room 本文の cutover 遅延: Backend 書込はプロセス内 emitter が届かず 5s ポーリング依存（dirty は非 delta のみ）。必要なら Room dirty / 短い busy 間隔
- cutover 実機では `npm run build:backend-runtime` で activity 付き omit を Backend バンドルへ載せる必要あり

## 検証

- remote-todo-progress 5 / harness-progress 該当 / rooms events 6 / shared-types 4 pass
- Push していない
