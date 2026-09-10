# Phase D リスクメモ（Goal Loop / regression / flaky test）

## 前提
`docs/plans/bot-mode/IMPROVEMENT_PLAN.md` は Phase D を event trigger・rich scheduling・guarded Bot-to-Bot workflow の検討とし、Goal Loop 統合は別設計と明記している。Bot routines と Goal Loop は混ぜない。

## 危険点
- Goal Loop は `%APPDATA%\leafcode-pi\goals-loop/<session>.json`（dataDir() 基準・プロジェクト内には置かない。拡張側は extensions/leafcode-goal-loop/index.ts の goalsDir()）を状態源にし、`queued/running/verifying_completed` を live と判定する（`lib/pi/goal-loop-state.ts`, `harness.ts`）。状態ファイル更新と session event/SSE の順序がずれると、UI の live/paused 表示、二重 resume、古い progress の危険がある。
- `goalLoopCommand()` は通常の `queuePrompt()` を通らず `live.session.prompt('/goal-*')` を直接呼ぶ。直前の chat hang-watch を残すと旧 prompt が Goal を abort する既知不具合があり、現在は prompt 直前に `disarmTaskHangWatch()` している。新しい command/trigger でも同じ境界を守る。
- Goal Loop は通常 chat の prompt queue、follow-up、silent resume と競合しうる。TaskView は goal live 中の送信を拒否し、resume では `stopRequested` を解除するが、将来の自動 trigger は per-task lock と state transition 検証なしに追加しない。
- 手動 stop / hang watchdog は assistant ID または空文字 sentinel を保存し、自動 compaction、SSE ready buffer、silent resume を抑止する。persist→emit→abort の順序、`hang_abort/hang_idle`、stale `isStreaming` の扱いを壊すと「停止後も working」「再開 UI 消失」「二重 prompt」になる。
- `TaskView` の `working` は `status === working || isStreaming`。`prompt_accepted`〜stream 開始、abort 後の遅延 delta、SSE reconnect の窓は特に regression が出やすい。`TaskView.resume.test.tsx`、`aborted-resume.test.ts`、`queued-follow-up.test.ts`、`sse-ready-buffer.test.ts` を回帰セットにする。
- `toSummary/resolveSummaryStatus` が stale live session を working に再昇格させる危険、`ensureLive()` の再 hydration と保存済み transcript の不整合、session replace 中の Goal Loop を見落とさない。Goal live 中は agent/model/session 切替を 409 で止める既存 guard (`throwIfGoalLoopBlocksSessionReplace`) を維持する。
- Host/WebUI restart は `host/src/host-restart.js` が lock 消滅を待って再起動する。in-memory live Map、room `roomBotRuns`、EventEmitter listener、routine scheduler interval は消える。保存済み task/room に `working` が残る前提で、再起動後に「勝手な再送」をしない reconcile が必要。

## 再現・確認手順（コード変更なし）
1. Goal Loop を短い maxTurns で開始し、実行中に Stop、SSE 切断/再接続、ページ reload、Resume を順に行う。期待: 1 回だけ再開し、旧 chat prompt/follow-up は実行されず、状態が paused/running と一致。
2. chat prompt を受理直後（stream 前）に Stop/Steer/Follow-up、さらに hang watchdog 相当の停止を行う。期待: stale delta で working に戻らず、resume payload が元 prompt/model/account を保持。
3. live Goal Loop の task で model/agent/session replace、通常送信、routine 実行を試す。期待: Goal Loop は独立、競合操作は明示エラーで拒否。
4. Host/WebUI restart の直前に room/Bot/routine/Goal を実行し、再起動後に履歴・状態・ボタンを確認。期待: durable な履歴は残るが in-flight を無言で二重実行しない。

## flaky test / 環境注意
- `web/vitest.config.ts` の既定 environment は `node`。React/DOM テストは先頭の `// @vitest-environment happy-dom` が必要。欠落・誤った test file 分割は `window is not defined` / `document is not defined` を起こす。現在の `GoalLoopPanel.test.tsx`、`TaskView.resume.test.tsx`、`RoomView.test.tsx` は happy-dom を宣言済み。
- Shell の `NODE_ENV=production` 継承は production React を Vitest に読ませ、React.act 未定義を大量発生させた既知問題。`vitest.config.ts` は `test.env.NODE_ENV = test` で対処済みだが、再現時は環境を固定して比較する。
- EventSource、fake timers、SSE ready buffer、global state (`globalThis` scheduler/harness) を使うテストは cleanup と serial 実行を確認。失敗時は全体再実行だけでなく上記の targeted tests を単独→同時実行で比較する。

## Phase D の最低限の mitigation
per-task/per-room lock、durable operation id、bounded retry、explicit permission/approval、hop/turn budget、restart reconciliation、SSE event ordering assertions、Goal Loop と routine の別 namespace/別 acceptance を先に設計する。Computer/isolation はこのスコープ外。
