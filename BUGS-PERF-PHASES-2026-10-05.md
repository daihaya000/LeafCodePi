# LeafCodePi BUGS-PERF 残件台帳（Phase 再編）

- 元: `BUGS-PERF-AUDIT-2026-10-03.md`（2026-10-05）
- 作成: 2026-10-05（Asia/Tokyo）
- **完了済み除外**。残りだけを作業順に Phase 化。
- **締め: 2026-10-05** — A〜C クローズ、残件数 0。Push はユーザー確認待ち。

## Phase 一覧

| Phase | テーマ | 件数 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- |
| **A** | ユーザー判断で閉じる | 4 | 受容 or 方針決定を元 MD に記録 | **クローズ** |
| **B** | 実装／設計選択 | 2 | 修正コミット or 構造制約として受容記録 | **クローズ** |
| **C** | 受入試験 | 1 | Windows E2E（または同等）結果を記録 | **クローズ** |
| **D** | 台帳締め | — | 残 0・件数断定・Push 確認 | **残 Push 確認のみ** |

旧 Phase 0〜3 / P1〜P9 の「完了枠」は本台帳に載せない。

---

## Phase A — 判断で閉じる（4）→ クローズ

| ID | 優先 | 箇所 | 決定・実装 | 状態 |
| --- | --- | --- | --- | --- |
| 105 | P5 | `llama-server/models` | **許可ルートのみ**: 既定 model root（`LEAFCODE_PI_LLAMA_MODEL_DIR` / bat 既定 / `~/models/llm`）＋設定の `modelDir`＋`LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST`（`;` 区切り）。範囲外は 403。回帰テスト追加。 | 修正済 |
| 114 | P5 | `direct-session` | **ハード予算**: poll あたり **8MB / 24 files**（`SESSION_PREVIEW_POLL_BUDGET_BYTES` / `SESSION_PREVIEW_POLL_MAX_FILES`）。sidebar が budget を渡し、超過分はプレビュー省略。 | 修正済 |
| 148 | P8 | `BotRoutineNotifier` | **fail-closed**: sidebar 取得失敗・`notificationsEnabled !== true` は通知しない。 | 修正済 |
| — | — | lease tombstone | 蓄積は既知トレードオフ | **残す（記録クローズ）** |

---

## Phase B — 実装か構造制約か（2）→ クローズ

| ID | 優先 | 箇所 | 実装 | 状態 |
| --- | --- | --- | --- | --- |
| 109 | P5 | `leafcode-goal-loop` | EBUSY/EPERM/EACCES の **rename retry を async**（`fs.promises.rename`）。成功パスの sync write+rename は原子性と既存の boolean fast path のため維持。retry がイベントループを ~39ms 塞がない。 | 修正済 |
| 127 | P6 | `child-process-watchdog` | Windows: 非 detached 子（libuv の KILL_ON_JOB_CLOSE job）。POSIX: 切り離し reaper が watchdog 消失後に子 PG を SIGTERM→SIGKILL。残差: reaper 自身が同時 SIGKILL された場合のみ孤児が残り得る（構造制約）。 | 修正済 |

---

## Phase C — 受入試験（1）→ クローズ

| ID | 優先 | 箇所 | 結果 |
| --- | --- | --- | --- |
| 91 | P4 | `host-restart` | Windows 隔離 E2E を `host-restart.test.js` に追加（lock 有無 × relaunch）。実機で dual-launch / relaunch 条件を検証。 |

---

## Phase D — 台帳締め

- [x] A〜C がすべてクローズ（修正済タグ or 見送り／受容の一文）
- [x] 元 MD の残件数 = 0
- [ ] 作業ツリー整理後 Push 確認（**ユーザー確認待ち・未 push**）
- [x] 既知 typecheck 3 件と混同しない

---

## 残件数クイック

**0**（tombstone は意図的トレードオフとして記録クローズ済み）。
