# LeafCodePi FE/BE 分離 バグ潰し / パフォーマンス (2026-10-02)

## 本ターンで追加した修正

### Sidebar / Code peek: idle Todo を共有ディスクから（正しさ / stampede 回避）

- 証拠: cutover 後 `buildTaskSummariesWithTodoProgress` は working / goal-loop のみ omit。idle はバー欠落。
- N×omit 全件は stampede。Pi `SessionManager.open` 全件は秒単位。
- 修正: `readDiskTodoProgress`（`readSessionWorkSummary` + mtime キャッシュ）で idle を共有 session ファイルから投影。
  - Sidebar / Bot Code panel: omit は working・goal-loop のまま。欠落分はディスク。
  - `peekCodeRequestProgress`: ディスク優先。omit は `status === "working"` の live activity のみ。
- テスト: `disk-todo-progress` / remote-todo / harness-todo / direct-session / Sidebar / code-requests / harness-progress。

## 残課題の証拠ベース監査

| 項目 | 状態 | 根拠 |
|------|------|------|
| 非 working Sidebar todoProgress（N×omit 無し） | **done** | 共有ディスク + mtime キャッシュ。omit は live のみ |
| フル delta 中継 | **deferred** | 大型 API。Room dirtyQueued/disk-first と 2s 安全網で本文は実用 |
| Room: dirty 無し区間 ≤2s | **accepted** | dirty 接続時 2s 安全網。busy 落ち / pending 待ちは d04be5e9 で解消。これ以上は delta 中継待ち |
| ownership fallback / soft-fail empties / cold Pi / missing forward | **done（本ターン再監査）** | `LOCAL_ONLY_PENDING` / `HANDLER_GAPS` 空。detail/messages は no local fallback。createSession は assertLocal。cold Pi は summaries/peek から外した |
| `build:backend-runtime`（activity 付き omit） | **運用メモ** | 実機バンドル再生成が必要な場合あり（コード缺陷ではない） |

## ゴール判定

- 本ターンで material な cutover 正しさ欠落（idle Todo 欠落）を修正済み。
- 意図的 defer（フル delta）と accepted（2s 安全網）のみ残る。
- UpdateGoal complete はツール未提供のため未実行。残るのは意図的 defer/accepted のみなら親側で complete 判断可。

## 検証

- disk-todo-progress / remote-todo-progress / harness-todo / direct-session / Sidebar / code-requests / harness-progress / room-events.concurrent: pass
- Push していない
