# MEMORY

## 2026-09-21: /loop 2m バグ・最適化・矛盾修正

### ループ
- `/loop 2m` 継続中（ユーザー明示停止まで）
- センチネル: `AGENT_LOOP_TICK_bugfix`
- プロンプト ASCII: `find and fix bugs, insufficient optimizations, and contradictions`
- PID: 31808（文字化けした旧ループは停止済み）

### Tick1
1. `replaceLiveForRoute` — `accountIdExplicit` オプション追加。limit fallback 時は pin を外し、pending model 適用時は要求フラグを反映
2. `listProjects(true)` — キャッシュ配列そのものではなく `slice()` コピーを返す（破壊的変更のストア汚染防止）
3. 回帰: `harness-limit-fallback`（明示 pin → fallback 後 `accountIdExplicit` 未定義）/ `store`（listProjects コピー）

### 検証（Tick1）
`harness-limit-fallback` / `store` — **15 passed**

### Tick2（ループ継続）
1. `GET /api/bots/[id]/code-session` — active のみ取得 + Goal Loop DTO を `loops` 同梱（クライアント N+1 廃止）
2. `BotCodeSessionPanel` — `/api/projects` は初回のみ、ポーリングは code-session のみ
3. `PartView.useElapsedMs` — ツールごとの 100ms timer を 250ms 共有クロックに集約

### 検証（Tick2）
`code-session/route.test` — **27 passed**

### Tick3（ループ継続）
1. `resolveCreateTaskModelSelection` / `validateTaskModelSelection` — ソフト `accountId` だけでは pin しない（モデル文字列のアカウント接頭辞 or 明示フラグのみ）。`generateDirectText` / `setTaskModel` と契約を統一

### 検証（Tick3）
`harness-routing` / `harness-complete` / `harness-limit-fallback` — **54 passed**

### Tick4（ループ継続）
1. `BotCodeSessionPanel` — `active` で非表示タブの 2s ポーリング停止（`BotCodeRequests` と同型）+ `document.visibilityState`
2. poll effect — `tasks` 配列ではなく `needsPoll` 真偽で interval を張り直し（応答ごとのタイマーリセット防止）
3. `GET code-session` — 二重 `reconcileOrphanedWorkingTasks` を削除（summaries 側に一本化）

### 検証（Tick4）
`BotCodeSessionPanel` / `code-session/route` — **34 passed**

### Tick5（ループ継続・通知 4–6 をまとめて消化）
1. `POST /api/tasks` — soft `accountId` だけでは pin しない（`accountIdExplicit: true` またはモデル文字列の account 接頭辞のみ）
2. `HomeView` — アカウント選択行から送るとき `accountIdExplicit: true` を明示

### 検証（Tick5）
`tasks/route.test` — **23 passed**

### Tick6（ループ継続）
1. `getBotCodeSessionPanelState` — bot 絞り込み後にだけ cold progress / Goal Loop を読む（全 Code 走査を回避）
2. `GET code-session` — 上記ヘルパーに委譲（loops は同一読込を再利用）

### 検証（Tick6）
`code-session/route.test` — **27 passed**

### Tick7（ループ継続）
1. `subscribeSharedElapsedClock` を `ui.tsx` に集約 — `useToolElapsedMs` と `PartView` が同一 250ms クロックを購読
2. `BotCodeSessionPanel.needsPoll` — `loops` の live 状態も見て poll 継続；`control()` 後に `load()` で loops 同期
3. `CodeRequestCard` — hidden タブでは detail ポーリングをスキップ

### 検証（Tick7）
`BotCodeSessionPanel.test` — **7 passed**

### Tick8（ループ継続・通知 9–10 をまとめて消化）
1. `peekCodeRequestProgress` + `GET code-requests` — 一覧に軽量 progress を同梱
2. `CodeRequestCard` — 折りたたみ中は full detail を取らない（プレビュー開時のみ `/api/tasks/:id`）
3. `BotCodeRequests` — hidden タブでは一覧 poll をスキップ

### 検証（Tick8）
`CodeRequestCard` / `BotView.code` — **68 passed**

### Tick9（ループ継続）
1. `BotCodeRequests` — 全 `requestIds` が terminal になるまで poll 継続（一部だけ delivered で止まらない）
2. `peekCodeRequestProgress` — cold ToDo は `loadPi()` してから読む；settled request は route 側で peek スキップ

### 検証（Tick9）
`BotView.code`（terminal poll 回帰含む）— 関連テスト通過

### Tick10（ループ継続・通知 12–14 をまとめて消化）
1. `types.RoomMessage.codeRequests` — `goalLoopSummary` / `todoProgress` / `activity` を追加
2. `trackRoomCodeProgress` — `peekCodeRequestProgress` でカード単位の進捗を Room メッセージへミラー（折りたたみ詳細 poll 不要）
3. `RoomView` — `codeRequests()` が per-card `activity` などを渡す
4. テスト — concurrent は props の activity を前提に変更；harness mock に peek を追加

### 検証（Tick10）
`RoomView` / `RoomView.concurrent` / `room-runtime` — **79 passed**

### Tick11（同バッチ・レース修正）
1. `trackRoomCodeProgress` — peek 後の `codeRequests` 更新を関数パッチでロック内マージ（並列 sibling の lost-update 防止）
2. 回帰: 遅延 peek が逆順に解決しても両カードの activity / todoProgress が残る

### 検証（Tick11）
`room-runtime` レースケース含む — **79 passed**

### Tick12（ループ継続・通知 15–17）
1. `peekCodeRequestProgress` — live セッションの latest-only 投影から `activity`（ツールラベル）を返す
2. `BotCodeRequests` — `activity` を `CodeRequestCard` へ渡し、折りたたみ時もツール名を表示
3. Room マージ — subscribe の label を peek の activity より優先

### 検証（Tick12）
`CodeRequestCard` / `BotView.code` / `room-runtime` — **120 passed**

### Tick13（ループ継続・通知 18）
1. `CodeRequestCard` — `ready`（結果報告中）でも停止可能に（`canStop` と `live` を分離）。サーバ `stopBotCodeRequest` と契約を揃える

### 検証（Tick13）
`CodeRequestCard` — **5 passed**

### Tick14（ループ継続・通知 19–20）
1. `processRequest` 配信後の `delivered` 保存を `request-*` ロック下で再読込 — 配信中のユーザー停止を成功結果で上書きしない
2. `complete()` — `ready` + `stoppedByUser` でも停止 outcome を永続化
3. 回帰: deliver 完了より先に stop しても最終 outcome は「ユーザーが停止」

### 検証（Tick14）
`bot-code-relay` — 関連ケース通過

### Tick15（ループ継続・通知 21–22）
1. `roomSnapshotSignature` — `codeRequests` の `activity` / `todoProgress` / `goalLoopSummary` と全メッセージの `codeActivity` を署名に含め、同 ms 進捗更新でも SSE が飛ぶようにする

### 検証（Tick15）
`room-events` / concurrent — **5 passed**

### Tick16（ループ継続・通知 23–24）
1. outbox `save()` — Room カード差し替え時に live 進捗をマージ保持；`codeActivity` はメッセージ上に live カードが無いときだけクリア

### 検証（Tick16）
`bot-code-relay` Room 進捗保持 — **76 passed**

### Tick17（ループ継続・通知 25–27）
1. `code-session` Goal Loop `stop` — `goalLoopCommand` ではなく `stopBotCodeTask` 経由にし、outbox に `stoppedByUser` を付けて追従 Code を拒否する

### 検証（Tick17）
`code-session/route` — **27 passed**

### Tick18（ループ継続・通知 28–29）
1. `botIdForCodeTask` — TaskView 用に所有者 Bot を解決
2. `/api/tasks/[id]/abort` と goal-loop `stop` — Bot 所有 Code は `stopBotCodeTask` 経由（パネル停止と契約を揃える）

### 検証（Tick18）
`tasks abort` / `goal-loop` — **15 passed**

### Tick19（ループ継続・通知 30–31）
1. `isGoalLoopOperatorHold` — user / manual_send の pause は Resume 前提
2. Bot Code outbox — operator hold 中は settle/deliver しない；`isBusy` も hold を busy 扱い
3. turn_limit pause の配信は従来どおり

### 検証（Tick19）
`goal-loop-state` / `bot-code-relay` — **80 passed**

### Tick20（ループ継続・通知 32–33）
1. `roomRequestIsCurrent` — `/stop` 投稿と stop による error 閉じを差し替えとみなさない（実行中 Code は継続・結果配信可）
2. 本物の新規依頼での cancel/abort は維持

### 検証（Tick20）
`bot-code-relay` Room /stop — 関連ケース通過

### Tick21（ループ継続・通知 34–35）
1. Bot 間インターコム — idle resident への `delivered` でモデルを起床（`ask` は replies ポリシーで必須、`send` は always のみ）
2. harness — steered 時のみ `streamingBehavior: "steer"`、idle wake は通常 prompt

### 検証（Tick21）
`bot-intercom` — 関連ケース通過

### Tick22（ループ継続・通知 36–39）
1. `flushQueuedBotIntercom(botId)` — Room busy / offline 解除後に inbound `delivery: "queued"` を `delivered`/`steered` へ昇格し、必要なら wake
2. harness Room prompt `finally` — `promptActive` クリア後に `flushQueuedBotIntercom` を呼び、Room ターン終了で放置されていた DM（特に ask）を起床
3. `wakeSteerIfNeeded` — send 時と flush 時で同一 wake 判定を共有

### 検証（Tick22）
`bot-intercom` — **30 passed**

### Tick23（ループ継続・通知 40–41）
1. 1:1 Bot `attachSession` 後に `flushQueuedBotIntercom` — offline→resident 復帰で queued を昇格（Room attach では呼ばない＝Room 開始直前の誤 wake 防止）
2. `abortTask` の Room タスク終了時にも flush — `cancelHarnessPrompt` 後 finally 遅延/欠落でも queued が残らない

### 検証（Tick23）
`bot-intercom` — **31 passed**

### Tick24（ループ継続・通知 42）
1. `disposeLive` — Room live を map 削除**前**に flush（削除後は resident=false で queued が永久放置される矛盾）
2. `flushQueuedBotIntercom({ ignoreRoomBusy })` — 他 Room が忙しくない tear-down では自セッションの busy を無視して昇格

### 検証（Tick24）
`bot-intercom` — **32 passed**

### 次 Tick 候補
- intercom 以外（Code progress / Goal Loop）の矛盾へ戻る
- harness 統合での disposeLive flush 回帰












---

## 2026-09-14: 徹底バグハント（アカウント一時停止）

### ループ
- `/loop 5m` 継続中（ユーザー明示停止まで）
- センチネル: `AGENT_LOOP_TICK_thorough_bug_hunt`
- プロンプト ASCII: `thorough bug hunt until user explicitly stops`（PowerShell 文字化け回避）

### 修正
1. `setProviderOrModelEnabled` — 一時停止アカウント / 統合全停止で 409
2. `resolveConcreteModel` — 登録アカウント全停止時 409（旧: 400 モデル不明）
3. `PATCH /api/accounts/[id]` — `enabled` 変更で `invalidateHealthCache()`
4. `/api/codexbar/reset-credits` — 一時停止 409
5. `validateModelAccountSelection` — create 前に 409（タスク孤児化防止）
6. `saveProviderModelsOrder` — 一時停止アカウントの並び変更を拒否
7. `setTaskModel` — 明示 pin / 一時停止を尊重（auto 時は再ルート可）
8. `generateDirectText` + auto-agent / next-action / permission advice — `accountIdExplicit` 伝播

### 残存リスク
- 統合ルーティングで非明示タスクは別アカウントへ切替しうる
- 進行中ストリームは一時停止直後も完走しうる
- 有効アカウント < 2 でも integrated モードは自動降格しない

### 検証
関連 vitest 6 files / **81 passed**（harness-complete/runtime, reset-credits, direct-generation, auto-agent, accounts）

### Tick1（同日継続）
1. `resolveConcreteModelWithFallback` — limit 判定を `route.accountId` 基準に（要求アカウントの stale limit で健全ルートを捨てない）
2. `bot-intercom` タイムアウトテスト — fake timers で flaky 解消
3. `resolveNoProjectRoot` — `platform` に応じた `posix`/`win32` join（Windows 上の linux テスト失敗を修正）
4. Cursor account-scoped `loadTokens` を configure/fetch 間でキャッシュ（auth.json 二重読込回避）
5. TaskView: エラーターン終了後のキュー drain 回帰テスト
6. `sysmon-linux` — sysfs 結合を常に `posix.join`（Windows 上の Linux モック失敗を修正）

### Tick2（ループ継続）
1. TaskView キュー drain — クライアント `error` バナーで永久停止しない
2. `generateDirectText` — `model.accountId` だけでは explicit pin にしない
3. `applySettledTaskStatus` / `handlePromptError` — 手動 Stop 後の abort settle を idle 維持

### Tick3（ループ継続）
1. `handlePromptError` — `stillQueued()` で stale epoch の非 abort エラーによる idle→error 上書きを防止
2. Goal Loop `prepareGoalLoopTurn` — 他プロンプト busy 中は prepare 前に `"retry"`
3. `pendingSettingsForPrompt` — queue 時点スナップショットではなく run 時点の pending を優先

### Tick4（ループ継続）
1. Goal Loop `canRetryGoalLoopProviderLimit` — pending クリア後も inflight / limit error から再試行可否を判定
2. provider fallback — settle 時に lease を保持し fallback 完了時に解放
3. Room `settleStaleRoomTurns` — 他ワーカーの `hasActiveTaskLease` を生存判定に使う

### Tick5（ループ継続）
1. `store.readStore` — 500ms TTL の blind return を廃止し、常に mtime/size で再検証（他ライター更新を即反映）
2. bot-intercom — `steered` 時に harness の steer handler 経由で `promptTask(..., steer)` を実行

### Tick6（ループ継続）
1. hang-watchdog — 別ワーカーが `hasActiveTaskLease` を持つとき missing-live で誤停止しない
2. TaskView 無言ターン自動再開 — 失敗時に `autoResumeKeyRef` をクリアして再試行可能に
3. OAuth/API login — answer/events に `sessionId` 必須（他タブのセッションへ誤回答しない）

### 検証（Tick6）
`hang-watchdog` / `login/answer` / `ProviderAuthPanel` — **38 passed**

### Tick7（ループ継続）
1. `goalLoopCommand` — 通常チャット busy 中の start/resume を 409（二重 `session.prompt` 防止）
2. `deleteAccount` — bot タスク + Goal Loop live（queued/running/verifying）も 409
3. Room — fan-out も supersede/stop 後は再 prompt しない；`stopRoomTurns` が placeholder を先に閉じる

### 検証（Tick7）
`accounts` / `room-runtime` / `hang-watchdog` — **71 passed**

### Tick8（ループ継続）
1. provider-limit fallback — `finally` で `promptActive` 中の lease を解放しない
2. `isTaskRuntimeOwnedElsewhere` — bot 限定をやめ、外部 lease 全般で offline/409
3. auto-compaction — `pendingProviderFallback` / inflight fallback 中はスキップ

### 検証（Tick8）
`harness-limit-fallback` / `harness-agent` / `events` / `task-runtime-lease` — **41 passed**

### Tick9（ループ継続）
1. TaskView compact 失敗時に `isCompacting` をクリア（送信ブロック防止）
2. Bot intercom steer — mailbox 添付を `promptTask` に渡す
3. Room handoff — `appendRoomMessage` 失敗時に `running` 固定せず `failed` へ

### 検証（Tick9）
`TaskView` / `bot-intercom` / `room-runtime` — **117 passed**

### Tick10（ループ継続）
1. GlobalAttention — 承認/回答後に task detail を再取得し、キュー次件を消さない
2. bot-code-relay — 承認前に `followUpStarted` を立てない（却下後の再試行可）
3. TaskView — compact abort 時に `compactingLocal` をクリア

### 検証（Tick10）
`GlobalAttention` / `bot-code-relay` / `TaskView` — **131 passed**

### Tick11（ループ継続）
1. GlobalAttention — question 拒否後も detail 再取得（キュー次質問を消さない）
2. hang-watchdog — foreign lease 中は `missingLiveSince` をクリアし、lease 終了後に grace を振り直す
3. TaskView SSE 再接続 — `questionRequest` も permission と同様にクリア

### 検証（Tick11）
`hang-watchdog` / `GlobalAttention` — **37 passed**

### Tick19（ループ継続）
1. TaskView — `abortCompact` 失敗時も `isCompacting` / `compactingLocal` をクリア
2. SSE fatal error — `sessionHydrating` を解除しキュー drain / resume を永久ブロックしない
3. remote_poll — offline null の permission/question を送らず、バッファ済み attention を消さない

### 検証（Tick19）
`TaskView` / `events/route` — **60 passed**

### Tick20–21（ループ継続）
1. room-runtime — Code 進捗ミラーを request 単位で解除（兄弟 pending で listener が残らない）
2. bot-code-relay — userIntervention が `starting` で永久停滞しないよう再キュー
3. bot-code-relay — `starting` かつ `codeTaskId` 未リンク中は誤 interrupted しない

### 検証（Tick20–21）
`room-runtime` / `bot-code-relay` — **112 passed**

### Tick22–23（ループ継続）
1. Room steer — 割り込みメッセージの画像/ファイルを `promptTask` に渡す
2. `patchAccount(enabled:false)` — delete と同様に working / live Goal Loop を 409 拒否

### 検証（Tick22–23）
`accounts` / `rooms/prompt` / `room-runtime` — **113 passed**

### Tick24–25（ループ継続）
1. Room 新指示 — 旧 Code outbox を `cancelRoomCodeRequests`；relay は superseded を running/ready でも cancel+abort
2. RoomView — 回答済み permission/question を cleared-id で stale SSE から復活させない
3. GlobalAttention — question 応答にも busy / エラー処理

### 検証（Tick24–25）
`bot-code-relay` / `rooms/prompt` / `RoomView` / `GlobalAttention` / `room-runtime` — **213 passed**

### Tick26–27（ループ継続）
1. BotView — cleared permission/question id + attentionBusy（stale SSE 復活／二重送信防止）
2. GlobalAttention — `/bots/*`・`/bots/rooms/*` をインライン扱いに（音・モーダル二重化防止）
3. openTask — Bot/Room attention は `paneTabIdForTask` へ遷移

### 検証（Tick26–27）
`task-panes` / `GlobalAttention` / `BotView.code` — **169 passed**

### Tick28（ループ継続）
1. TaskView — cleared permission/question id で stale SSE スナップショットからの attention 復活を防止
2. RoomView — `resetConversation` で attention / busy / cleared refs をクリア
3. Room `resetMessages` — ターン停止・handoff 取消・Code 取消・メンバー会話リセット後にパッチ

### 検証（Tick28）
`TaskView` / `RoomView` / `rooms/[id]` / `bot-code-relay` — **141 passed**

### Tick29–31（ループ継続）
1. `revertTask` — pending permission/question をクリア（abort/reset と同等）
2. `clearPendingAttentionForTask` — Bot 起源の委任 Code キューもクリア
3. Room revert API — メンバー task の attention をクリア
4. RoomView / BotView / TaskView — 巻き戻し成功時に attention UI をクリア

### 検証（Tick29–31）
`harness-bot-code` / `rooms/revert` / `RoomView` / `BotView.code` — **94 passed**

### Tick32–33（ループ継続）
1. `revertTask` / `unrevertTask` — streaming・compacting・promptActive・Goal loop live を 409 拒否
2. TaskView — 復元中/確認中は送信不可、working 中は復元ボタン無効
3. RoomView / BotView — 巻き戻し中は composer 送信・添付をブロック

### 検証（Tick32–33）
`harness-revert` / `RoomView` / `BotView.code` / `TaskView` — **150 passed**

### Tick34（ループ継続）
1. `isTaskRuntimeBusyForDestructiveEdit` — lease / fallback / compaction を promote・revert 共通で拒否
2. アカウント pause/delete — `hasActiveTaskLease` も 409（fallback 中の idle/error を含む）
3. Bot ルーティン — `lastRunAt` は成功時のみ更新、lease busy は failureCount 非加算

### 検証（Tick34）
`accounts` / `routines` / `harness-promote` / `harness-revert` — **76 passed**

### Tick35–36（ループ継続）
1. Room DELETE — resetMessages と同様に turns/handoff/Code を先に停止
2. Bot skills PATCH — `resetTaskSession` ではなく SOUL と同じ `requestBotSoulReload`（busy 中 dispose 防止）
3. follow-up キュー — `archived` / `conversation_reset` でクリア（restore 後の自動送信防止）

### 検証（Tick35–36）
`rooms/[id]` / `bots/[id]` / `queued-follow-up` — **35 passed**

### Tick37–38（ループ継続）
1. Bot DELETE — 所属 Room で `detachBotFromRoomRuntime` + 全 Code origin キャンセル後に destroy
2. Room PATCH members — 外したメンバーを detach（turns/handoff/Code）してから membership 更新
3. Bot PATCH permissionMode — `setTaskPermissionMode` で live セッションへ反映（busy 時 defer）

### 検証（Tick37–38）
`bots/[id]` / `rooms/[id]` / `bot-code-relay` — **87 passed**

### Tick39（ループ継続）
1. Bot `enabled:false` — 所属 Room で `detachBotFromRoomRuntime`（membership は維持、1:1 は許可）
2. ルーティン — `bot.enabled` を tick / run 両方で確認
3. `reloadLiveSessionsContext` — busy セッションは skip（Bot は soulReloadPending）

### 検証（Tick39）
`bots/[id]` / `routines` / `harness-agent` — **77 passed**

### Tick40–41（ループ継続）
1. Bot PATCH `permissionMode` / `model` / `thinkingLevel` — `applyBotSettingToLiveTasks` で 1:1 + 委任 Code + Room live へ反映
2. `reloadLiveSessionsContext` — busy の非 Bot は `contextReloadPending`；次の `prepareLiveForPrompt` で `reloadLiveContextIfNeeded`
3. `destroyTask` / `destroyProject` / archived-by-project — `clearBotCodeSessionLinks` で dangling `codeSessionTaskId` を解除
4. code-session API — 欠損タスク参照時に `codeSessionTaskId` を自動クリア

### 検証（Tick40–41）
`bots/[id]` / `code-session` / `harness-agent` — **56 passed**

### Tick42–43（ループ継続）
1. `setBotTools` — busy 中は `pendingSettings.botTools` へ defer（mid-stream 即時変更を防止）
2. `reloadLiveContextIfNeeded` — `promptActive` を busy 判定から除外（prepare 中の永久 defer を修正）
3. `archiveTask` — `clearBotCodeSessionLinks` でアーカイブ後の dangling link を解除
4. `patchColdBotSiblingTasks` — 非 live の Room Bot タスクへ permission/model/thinking を store 同期

### 検証（Tick42–43）
`bots/[id]` / `harness-agent` — **44 passed**

### Tick44–45（ループ継続）
1. `pendingSettingsForPrompt` — resolved streamingBehavior を使い、終了後 followUp で deferred settings を適用
2. mid-stream — soft settings（botTools / permission / subagent）のみ即時適用
3. `goalLoopCommand` start/resume — `prepareLiveForPrompt` で deferred を先適用
4. Bot `enabled:false` — Room detach に加え `cancelBotCodeRequests` で 1:1 Code も停止

### 検証（Tick44–45）
`bots/[id]` / `harness-prompt` / `harness-agent` — **79 passed**

### Tick46（ループ継続）
1. Bot `enabled:false` — `codeSessionTaskId` の linked Code（Goal Loop 等、relay なし）も `stopBotCodeTask` で停止
2. `goalLoopCommand` prepare — `reroute:false` に変更（turn 側 prepare との二重アカウント再選択を回避）
3. 残存: Goal Loop ターン自体の hang watchdog 武装は未着手（queuePrompt 経路のみ）

### 検証（Tick46）
`bots/[id]` / `harness-prompt` / `harness-agent` — **80 passed**

### Tick47–49（ループ継続）
1. Bot `enabled:false` — 実行中の 1:1（`bot:${id}`）も `abortTask`（新規 DM は従来どおり許可）
2. code-session API — disabled Bot の POST / prompt / Goal resume を 403；pause/stop/abort は継続可
3. bot-code-relay — owner 失敗時に Code タスクも abort（cancel-only の orphan 防止）
4. Goal Loop — `prepareGoalLoopTurn` 成功時に `armTaskHangWatch`
5. harness-routing — 外部 lease は 409 throw を期待するようテスト修正

### 検証（Tick47–49）
`bots/[id]` / `code-session` / `bot-code-relay` / `harness-routing` — **131 passed**

### Tick50（ループ継続）
1. hang-watchdog — Goal Loop arm に `skipResume`（hang abort 後に routing 文を通常 chat 再送しない）
2. `goalLoopCommand` — `promptEpoch` で abort/disable 後の stale `/goal-start|resume` を抑制
3. code-session clear/unlink — working 中の linked Code を先に `stopBotCodeTask`

### 検証（Tick50）
`hang-watchdog` / `code-session` / `bots/[id]` / `harness-prompt` — **87 passed**

### Tick51–52（ループ継続）
1. `goalLoopCommand` stale — prepare 後の `working`+lease を rollback（ゾンビ working 防止）
2. code-session clear/unlink — `body.taskId` を停止対象にし、`codeSessionTaskId` クリアは一致時のみ

### 検証（Tick51–52）
`code-session` / `harness-routing` / `bots/[id]` / `hang-watchdog` — **80 passed**（code-session 単独再実行 **20 passed**）

### Tick53（ループ継続）
1. code-session clear/unlink — Goal Loop live（task idle でも）なら `stopBotCodeTask`
2. `isRoomDelegatedCodeTask` — Bot code-session API が Room 委譲 Code を abort/prompt/一覧しない

### 検証（Tick53）
`code-session` / `bot-code-relay` — **90 passed**

### Tick54（ループ継続）
1. Bot `resetMessages` — `cancelBotCodeRequests` + linked `codeSessionTaskId` を stop/abort してから会話リセット（disable と対称）
2. `listPendingAttention` — `listTasks(false)`（code のみ）ではなく pending id を `getTask` で解決（kind=bot の承認/質問が GlobalAttention に出る）
3. queued follow-up — `goal_command_stale` でもクライアント側キューをクリア

### 検証（Tick54）
`bots/[id]` / `queued-follow-up` / `harness-bot-code` — **43 passed**

### Tick55–56（ループ継続）
1. Bot DELETE — linked `codeSessionTaskId` を stop/abort（disable/reset と対称。relay 外の Goal Loop/panel Code 孤児防止）
2. `goalLoopCommand` — `session.prompt` 直前に `promptEpoch` を再検査（prepare 後の abort/disable TOCTOU）
3. GlobalAttention — 委任 Code の `originTaskId` を返し、Bot/Room 画面ではインライン扱い（二重ベル/モーダル防止）

### 検証（Tick55–56）
`bots/[id]` / `task-panes` / `GlobalAttentionProvider` / `queued-follow-up` — **147 passed**

### Tick57–58（ループ継続）
1. GlobalAttention「開く」— `originTaskId` があれば Bot/Room タブへ（委任 Code を `/task/code-*` に誤誘導しない）
2. code-session clear/unlink — `stopBotCodeTask` 失敗時に `abortTask` フォールバック（disable/delete と対称）
3. relay `isBusy` — live 無しでも Goal Loop ファイルが live なら busy（ premature deliver 防止）
4. Room DELETE/reset — `stopAllRoomCodeSessions` で outbox 外の working/Goal Loop Code も停止

### 検証（Tick57–58）
`code-session` / `rooms/[id]` / `task-panes` / `GlobalAttentionProvider` — **136 passed**

### Tick59–60（ループ継続）
1. `abortTaskIncludingColdGoalLoop` — live 無しの Goal Loop を `goalLoopCommand(stop)` してから abort（destroy/archive/relay cancel 共通）
2. `stopRoomCodeSessionsForBot` + `detachBotFromRoomRuntime` — メンバー除去でも cold Goal Loop Code を停止
3. `archiveProjectAndStopTasks` — プロジェクトアーカイブ前に配下タスクを停止

### 検証（Tick59–60）
`harness-lifecycle` / `bot-code-relay` / `rooms/[id]` / `bots/[id]` / `harness-agent` — **122 passed**

### Tick61（ループ継続）
1. `stopBotCodeTask` — `abortTaskIncludingColdGoalLoop`（linked Code の cold Goal Loop）
2. `stopOneToOneCodeSessionsForBot` / `stopAllCodeSessionsForBot` — 1:1 disable/reset/delete でも Room 相当の cold sweep
3. `stopCodeSessionsForProject` — archive 時に relay outbox も停止（restore 後のゴースト配信防止）
4. Bot disable の 1:1 abort も cold Goal Loop 対応

### 検証（Tick61）
`bots/[id]` / `bot-code-relay` / `harness-lifecycle` / `harness-agent` / `code-session` — **142 passed**

### Tick62–63（ループ継続）
1. Bot DELETE — `listTasks(true,"all")` で kind=code も `destroyTask`（孤児 Code タスク掃除）；`deleteBot` も all
2. Code 依頼 abort（Bot/Room）+ Task abort + code-session fallback — `abortTaskIncludingColdGoalLoop`
3. hang watchdog `onMissingLive` — error 前に cold Goal Loop を停止

### 検証（Tick62–63）
`bots/[id]` / `code-session` / `rooms/.../code` / `harness-lifecycle` / `hang-watchdog` — **67 passed**

### Tick64（ループ継続）
1. Room fan-out — ready handoff がフロアを取ったら sibling placeholder を `"Handoff took the floor."` で止め、`deliverReadyRoomHandoffs`；次 sibling 開始前にも handoff 再確認
2. `runRoomBot` — 最終 `done` 書き込みを `status === "working"` のときだけ原子的に行い、Stop/handoff 後の上書きを防止
3. Settings 直接生成 — `accountId` 付き候補は `accountIdExplicit: true`（ピン固定）
4. `getTaskDetail` — live/archive の attention を `pendingPermissionForTask` / `pendingQuestionForTask` に統一

### 検証（Tick64）
`room-runtime` / `direct-generation` — **64 passed**

### Tick65–67（ループ継続・通知スタック消化）
1. `streamRoomReply` — 閉じ済み placeholder を late delta で `working` に戻さない
2. `runRoomBot` catch / supersede / inactive — `status === "working"` のときだけ閉じる（handoff 文言の上書き防止）
3. 回帰テスト: late stream が handoff close を復活させないこと

### 検証（Tick65–67）
`room-runtime` — **48 passed**

### Tick68（ループ継続）
1. `refreshTaskTitleDirect` — `task.accountIdExplicit` を直接生成へ転送（一時停止アカウントの暗黙切替防止）
2. `resolveRoomOpener` — 呼び出し元 `accountId` 指定時は `accountIdExplicit: true`

### 検証（Tick68）
`direct-title` / `room-opener` — **9 passed**

### Tick69（ループ継続・[Hunt non-lifecycle bugs](b415cde0) 追随）
1. `runRoomBot` — prompt 後の supersede でも placeholder を閉じる（`working` 残留防止）
2. `deliverReadyRoomHandoffs` — claim→envelope、消費済み token は再発行；reply なし時に placeholder 閉じ
3. `registerRoomHandoff` — evict 時は `toolCallId` 無し settled を優先
4. provider login DELETE — `sessionId` 必須（`cancelProviderLogin(sessionId)`）

### 検証（Tick69）
`room-runtime` / `login/answer` — **55 passed**

### Tick70（ループ継続・[Hunt fresh high-confidence bugs](96016c4d) 追随）
1. `originForCode` / `codeTasksForOrigin` — `starting|running`（`requestIdForCode` と統一；attention origin 欠落防止）
2. POST `/api/tasks` — 非 auto create の `resolveAutoAgent` に `accountIdExplicit`
3. Bot intercom — Room 稼働を presence busy + delivery `queued`（DM への誤 steer 防止）
4. （#1 direct-title pin は Tick68 済み）

### 検証（Tick70）
`bot-code-relay` / `tasks/route` / `bot-intercom` — **118 passed**

### Tick71–72（ループ継続・通知スタック消化）
1. Bot intercom resident — Room live（`bot:<id>:room:*`）も resident に含め、Room 専用稼働を offline 扱いしない
2. POST `/api/tasks` — 非 auto + `accountId` 時は `createTask` にも `accountIdExplicit: true` を明示

### 検証（Tick71–72）
`tasks/route` / `bot-intercom` — **49 passed**

### Tick73（ループ継続）
1. アカウント一時停止/削除 — hang watchdog 監視中（abort→resume で status=idle の隙間）も 409
2. GlobalAttention — Bot/Room の `taskId`（`:` 含む）を `encodeURIComponent` して detail/permission/question を呼ぶ
3. Room events SSE — 委任 Code タスクにも `subscribeTask` し、許可待ちを 2s ポーリング待ちにしない

### 検証（Tick73）
`accounts` / `GlobalAttentionProvider` — **42 passed**

### Tick74–75（ループ継続・[Hunt remaining](4a97a950) / [Hunt Tick73](870f68d7) / [Hunt Tick73 fresh](bf053a0d) 追随）
1. DELETE `/api/accounts/[id]` — `invalidateHealthCache()`（PATCH enabled と対称）
2. SSE ready buffer — `missing_live_session` を control snapshot に追加
3. Goal Loop `turn_timeout` — pause 後に `ctx.abort()`（ユーザー pause と同型）
4. hang-watchdog — `MAX_HANG_RETRIES=3` で auto-resume 打ち切り
5. steer demote — `skipHangRearm` で割り込み文が hang resume を上書きしない（実行開始時に arm）
6. git commit パス選択 — 欠落パスは `git add -u` で削除をステージ（rename 由来 pathspec miss は許容）

### 検証（Tick74–75）
`hang-watchdog` / `sse-ready-buffer` / `git/commit` / `accounts` / goal-loop extension — **passed**

### Tick76（ループ継続）
1. POST `/api/tasks/[id]/goal-loop` — 開始前に `isTaskRuntimeBusyForDestructiveEdit`；`goalLoopCommand` 失敗時は model/agent/thinking をロールバック
2. SSE ready buffer — `agent_routed` / `settings_pending` / `model_changed` を control に追加（ready 待ち中の破棄防止）

### 検証（Tick76）
`goal-loop/route` / `sse-ready-buffer` — **passed**

### Tick77（ループ継続）
1. Auto ルート候補 — `accountId` を候補型・正規化・`resolveCandidate`・設定 UI に通し、同一 provider/model の複数アカウントを区別

### 検証（Tick77）
`auto-model` / `AutoRouteOverridesEditor` — **32 passed**

### Tick78（ループ継続・[Hunt Tick76 fresh bugs](bb55ad66) 追随）
1. Goal Loop POST rollback — `previousModel` に `accountId` を含める；非 live な開始結果は 409 扱いでロールバック
2. Task SSE ready — `getTaskDetail` に 30s 上限、タイムアウト時は `offline` で degraded ready
3. ProviderAuthPanel login SSE — `onerror`（CLOSED 時）と JSON.parse 保護

### 検証（Tick78）
`goal-loop/route` / `events/route` / `ProviderAuthPanel` — **45 passed**

### Tick79–80（ループ継続・[Hunt Tick77 fresh bugs](3e8eac2b) 追随）
1. Bot SSE ready — Task SSE と同型に `getTaskDetail` 30s 上限、タイムアウト時は `offline` degraded ready
2. ProviderAuthPanel — `auth_url` / `device_code` の `window.open` を URL 単位で一度だけ（reconnect 履歴 replay の多重タブ防止）
3. ProviderAuthPanel — アカウント削除前に `stopLogin()`；当該アカウントのログイン中は削除ボタンを disabled

### 検証（Tick79–80）
`bots/[id]/events/route` / `ProviderAuthPanel` — **29 passed**

### Tick80（ループ継続・[Hunt Tick80](0071c500) 追随）
1. ProviderAuthPanel — `stopLogin` が常に generation を進め、開始中キャンセル後の遅延 `sessionId` は DELETE で孤児セッションを掃除
2. GET `/api/tasks/[id]/messages` — `getTaskDetail(..., { offline: true })`（ensureLive ハング回避）
3. GET `/api/tasks/[id]` — `getTaskDetailBounded`（30s → offline fallback）
4. GET `/api/tasks/[id]/goal-loop` — `goalLoopState(..., { offline: true })`
5. ProviderAuthPanel — ログイン中は cookie 保存を拒否

### 検証（Tick80）
`get-task-detail-bounded` / `messages/route` / `ProviderAuthPanel` / `goal-loop/route` — **38 passed**

### Tick81–83（ループ継続・[Hunt Tick81–83](fb85c6f1) 追随）
1. `goalLoopCommand` start/resume — `prepareLiveForPrompt` 後に `isLiveBusyForReplace` を再チェック（二重 `session.prompt` 防止）
2. `getTaskDetailBounded` — offline フォールバックにも 10s 上限、失敗時 503；Task/Bot SSE ready と remote_poll が共用
3. Bot prompt Goal Loop start — `isTaskRuntimeBusyForDestructiveEdit` で 409
4. `runRoutine` — 完了後の結果判定を `getTaskDetail(..., { offline: true })`

### 検証（Tick81–83）
`get-task-detail-bounded` / `accounts` / `routines` / Task+Bot SSE events — **76 passed**

### Tick84–85（ループ継続・[Hunt Tick84–85](897f0949) 追随）
1. `goalLoopCommand` — pause/stop/complete は stale epoch でも `/goal-*` を送る（hang abort 後の無音 no-op 防止）
2. Bot abort — `abortTaskIncludingColdGoalLoop`（Task abort / Bot disable と対称）
3. Bot prompt Goal Loop start — `isGoalLoopLiveStatus` で非 live を 409
4. `createTask` Goal Loop — 開始結果が非 live なら 409

### 検証（Tick84–85）
`bots/abort` / `bots/prompt` / `harness-lifecycle` / `goal-loop/route` — **29 passed**

### Tick86–87（ループ継続・[Hunt Tick86–87](6711b209) 追随）
1. Code session unlink/clear — 停止失敗時は link を残して 409（偽成功防止）
2. Goal Loop resume（Task PATCH / Bot code-session）— 非 live 結果は 409
3. Bot/Room Code abort — abort 失敗でも `completeBotCodeRequest` を finally で実行

### 検証（Tick86–87）
`code-session` / `goal-loop` / `rooms/.../code` — **40 passed**

### Tick88–89（ループ継続・[Hunt Tick88–89](149fe2c6) 追随）
1. Room revert — 無効 `messageId` では `stopRoomTurns` 前に 404（進行中ターン破壊防止）
2. `createTask` / `promptTask` — アーカイブ済みプロジェクトを 409 拒否
3. Code outbox — 失敗 result を JSON 化し、非 JSON でも outcome フォールバック

### 検証（Tick88–89）
`rooms/.../revert` / `harness-complete` / `bot-code-relay` — **83 passed**

### Tick90–92（ループ継続・[Hunt Tick90–92](4e461137) 追随）
1. `runRoutine` — `${id}.run.lock` でクロスワーカー claim（二重実行防止、409 は transient）
2. Room PATCH `codeAutoApprove` — `botRelayEnabled` と同様に Web UI トークン必須

### 検証（Tick90–92）
`routines` — **39 passed**；Room auth 関連 — **passed**

### Tick93–95（ループ継続・[Hunt Tick93–95](7518fc4a) 追随）
1. Bot PATCH `codeAutoApprove` — Room と同様に Web UI トークン必須（未認証 403）
2. Room `members` PATCH — 不明 Bot ID を黙って落とさず `assertKnownRoomMembers` で 400（偽 200 防止）
3. 先送り: permission/question の in-memory 404（multi-worker）、routine `.run.lock` 2h stale reclaim

### 検証（Tick93–95）
`bots/[id]/route` / `rooms` — **34 passed**

### Tick96–98（最終・ユーザー明示終了）
1. `restoreTask` — 親プロジェクトが archived なら 409（偽 idle / 後続 prompt 409 防止）
2. `destroyTask` — ensureLive epoch 再バンプ + inflight drain；`attachSession` / `attachCreatedLiveSession` はタスク消失時に attach 拒否
3. 先送り: TTS settings URL の SSRF（localhost allowlist 要検討）

### 検証（Tick96–98）
`harness-agent` — **29 passed**

### ループ終了
ユーザー「現 tick 終了次第、完了報告して明示終了」により `AGENT_LOOP_TICK_thorough_bug_hunt`（5分間隔）を停止。

## 2026-09-15: production typecheck 修復（Stale rebuild）

`next build` が TS エラーで失敗し Host が exit 1。修正:

1. `code-session/route.test.ts` — `readGoalLoopState` mock 戻り型を `{ status } | null`
2. `rooms/.../prompt/route.test.ts` — mock を `as typeof actual.*`（spread TS2556 回避）
3. `GlobalAttentionProvider` — `onReject` が `Promise<void>` を返すよう `void` 演算子を除去
4. `direct-title.test.ts` — `getSetting` mock に key 引数
5. `harness-agent.test.ts` — `applied` 断言と fixture `reload` / idle live エントリ型

検証: `tsc --noEmit` 成功；関連 vitest **54 passed**

---

## 2026-09-14: Stale production rebuild / next build exit 1

### Symptom
Host crashed with `Stale production rebuild failed and sources are still newer than the build (next build exited 1)` after `[build-web] rebuild failed; restored previous production build`.

### Root cause
`web/src/lib/codexbar/chromium-cookies.ts` imported `../../../../extensions/leafcode-web-access/chromium-cookie-crypto.ts`.
Production builds run in `%LOCALAPPDATA%\leafcode-pi\build\<slug>\`, which only mirrors `web/`. Turbopack cannot resolve modules outside that project root, so `next build` failed with Module not found.

### Fix
- Vendored shared crypto at `web/src/lib/codexbar/chromium-cookie-crypto.ts` (Must match the extension copy; extension remains installable alone).
- Pointed CodexBar imports at the in-tree module.
- Added a parity test so the two implementation bodies stay identical.

### Verify
- `node scripts/build-web.mjs --skip-guard` → exit 0
- `npx vitest run src/lib/codexbar/chromium-cookies.test.ts` → 10 passed

---

## 2026-09-14: Linux/macOS トレイをデスクトップ既定に

ユーザー要望「標準対応」。Windows のトレイ既定は維持。OAuth / TTS / cookies は未変更。

### 方針
- グラフィカルデスクトップではトレイ ON（`./start.sh` / `npm run host` に `LEAFCODE_PI_TRAY=1` 不要）
- オフ: `LEAFCODE_PI_HEADLESS=1` / `--headless`（常に優先）、または `LEAFCODE_PI_TRAY=0`
- Linux で `DISPLAY` / `WAYLAND_DISPLAY` 無し（素の SSH）はトレイを自動スキップ
- macOS は Aqua が DISPLAY を付けないため、SSH 無しをグラフィカル扱い。`LEAFCODE_PI_TRAY=1` はディスプレイ無しでも強制 ON

### 実装
- `host/src/config.js` `hasGraphicalSession()` / `shouldUseTray()`
- Linux/macOS の初回トレイ失敗はホストを落とさず継続（AppIndicator 欠如を hard crash にしない）。Windows は従来どおり失敗で終了
- llama-server の独立トレイは Windows のみ（ホストトレイと二重にしない）
- README の Linux 起動節と環境変数表を更新

### 検証
host `src/index.test.js` + `src/isolation.test.js` **32 passed**。host 全体 **177 passed**。

---


## 2026-09-14: Linux parity remaining（Chromium cookie・TTS・OAuth 文書・noProjectRoot）

master `028a3459`（PR #8/#9/#10 後）から `cursor/linux-parity-remaining-3e61`。Windows DPAPI / SAPI / start.bat は維持。

### 1. CodexBar Chromium cookie（Linux）
- `extensions/leafcode-web-access/chromium-cookie-crypto.ts` に secret-tool / peanuts / AES-128-CBC / ブラウザパスを抽出
- `chrome-cookies.ts` と CodexBar `chromium-cookies.ts` が共有。Windows は従来どおり DPAPI + AES-GCM
- `browser-cookies.ts` の `process.platform !== "win32"` 早期 return を削除。Netscape 手動フォールバックは維持
- Cookie DB は `Network/Cookies` 優先、なければ legacy `Cookies`
- Linux ルート: Chromium / Chrome / Brave / Edge（XDG `~/.config/...`）

### 2. Linux TTS UX
- ホストが非 win32 なら SAPI を選択肢から外し、AivisSpeech を推奨表示
- 空 URL の empty-state で無音の理由を説明。既存 AivisSpeech URL はそのまま
- Qwen TTS サーバーは再導入しない。CLI 拡張も Linux で空 URL の SAPI を起動しない

### 3. Remote OAuth
- README サブスク節に SSH `-L 53692 -L 1455` / API キー / device_code
- ProviderAuthPanel の「対応・設定方法」と OAuth ログイン面に同じヒント。redirect URI は変更なし

### 4. Tray
- README の Linux 起動節に `LEAFCODE_PI_TRAY=1` を明示。ヘッドレス既定は維持

### 5. noProjectRoot
- `~/Documents` があれば `~/Documents/LeafCodePi`
- 無ければ Linux/macOS は `$XDG_DATA_HOME/LeafCodePi` または `~/.local/share/LeafCodePi`
- Windows は Documents が無ければ `~/LeafCodePi`

### 6. Sysmon
- 変更なし（macOS / Intel iGPU / センサー無し VM は null のまま）

### 検証
関連 vitest 11 files / **101 passed**（chromium-cookies, cookie-providers, paths, tts-backends/config/synthesize, TtsSettings, ProviderAuthPanel, oauth-loopback, leafcode-tts, app-paths）。Web 全体も 325 files / 2612 passed。

### ブランチ / PR
`cursor/linux-parity-remaining-3e61` / https://github.com/daihaya000/LeafCodePi/pull/11
実装 SHA: `8a24abbb`

---

## 2026-09-14: Linux parity / cleanup（docs・Qwen TTS 削除・Explorer・sysmon）

master `e2bb92f4` から `cursor/linux-parity-cleanup-e913`。Windows 挙動は維持。

### 文言 / パス
- LoginForm はサーバ側で `displayLeafcodePiDataPath("webui-auth.json")`（Linux `~/.leafcode-pi/webui-auth.json`）
- README の Windows のみ bullets に Linux twin を追加
- ホスト起動ヒント: API は OS 別、設定 UI はクライアントで OS が取れないため `start.bat` と `./start.sh` / `npm run host` の両記

### 削除（Qwen TTS）
- プリセット `qwen`、`/api/settings/tts/server`、`extensions/leafcode-tts/server/`（ROCm start/stop）
- 残す: AivisSpeech / カスタム HTTP / SAPI。旧 `:18080` URL は custom 扱い（起動 UI なし）

### 移植
- host `openProjectInExplorer`: win32 `explorer.exe` / darwin `open` / linux `xdg-open`。常に register
- Quick Access: XDG `user-dirs.dirs` + 日本語フォルダ名。Windows COM pin は未変更
- sysmon CPU 温度: `/sys/class/thermal` + CPU hwmon（不明チップは読まない）
- AMD GPU: amdgpu sysfs（busy / VRAM / temp）。nvidia-smi はそのまま

### 残 null
- macOS CPU 温度 / AMD GPU
- Intel iGPU（信頼できる util+temp なし）
- センサー無し VM / `LEAFCODE_SYSMON_THERMAL=0`

### 検証（Linux）
- web 10 files / 44 tests PASS（paths, hints, TTS, Quick Access, sysmon-linux, Explorer button, cache）
- host open-explorer 2 PASS
- 空 sysfs を 0 にしないよう `parseAmdGpuBusyPercent` / `parseVramBytes` を修正

### ブランチ / PR
`cursor/linux-parity-cleanup-e913` / https://github.com/daihaya000/LeafCodePi/pull/10
実装 SHA: `8cba33f4` / sysmon 空値修正: `4a25f5ea` / lock+MEMORY: `39e0e024`

---

## 2026-09-14: Linux CodexBar / マルチアカウント / プロバイダ認証監査

master `08827d93`（PR #8 merge 後）を Ubuntu 上で調査。実ユーザートークンは使わず、偽 OAuth も作っていない。

### Verdict

| 領域 | 判定 | 理由 |
| --- | --- | --- |
| CodexBar | **PARTIAL** | 利用量 API・アカウントスコープ・Pi auth 読みは Linux で動く。既定スコープの Cursor IDE トークンと CodexBar 設定/cookie ディレクトリが `%APPDATA%` / `~/AppData/Roaming` 前提だった |
| Multi-account | **OK** | `~/.pi/agent/accounts/<id>/auth.json`、Home composer の account picker、task `accountId` 束縛は OS 中立。欠落 auth.json は空扱い |
| Provider auth | **PARTIAL** | Anthropic / Codex / API key / アカウント OAuth の保存先は Linux 正しい。OAuth コールバックはホスト loopback（`127.0.0.1:53692` / `localhost:1455`）。同一マシンのブラウザなら可。リモート/ヘッドレスはポートフォワードか API キーが必要。Chromium cookie 自動抽出は Windows のみ |

### 今回直した Linux バグ（外科的）

CodexBarWin 移植ヘルパーが `APPDATA` 未設定時に `~/AppData/Roaming` を作っていた。

- `web/src/lib/codexbar/app-paths.ts` — `roamingConfigDir()`。`APPDATA` 明示時は従来どおり（既存テスト互換）。未設定なら Linux=`$XDG_CONFIG_HOME` or `~/.config`、macOS=Application Support、Windows=Roaming
- `netscape-cookies.ts` `codexBarConfigDir()`、`cursor.ts` IDE パス、`browser-cookies.ts` の重複 APPDATA 解決をこのヘルパーへ集約

本番 Linux（APPDATA 無し）:

- CodexBar config / Ollama・OpenCode Netscape cookie → `~/.config/CodexBar/`
- Cursor IDE `auth.json` / `state.vscdb` → `~/.config/Cursor/...`（Electron の実パス）

### 残課題（今回は触らない）

- Chromium cookie 自動抽出（Qwen / OpenCode Go）は `process.platform !== "win32"` で即 null。Linux は Netscape 貼り付けか API キー
- `LoginForm.tsx` が `%APPDATA%\leafcode-pi\webui-auth.json` 固定。実体は `~/.leafcode-pi/webui-auth.json`
- README マルチアカウント節が `%USERPROFILE%\.pi\agent\accounts\` 表記（本文 48 行は Linux の `~/.pi/agent/auth.json` を正しく記載）
- リモート WebUI + 手元ブラウザの OAuth は、IdP がホスト loopback に戻すため失敗する（設計）。SSH `-L 53692 -L 1455` か device_code / API キー
- `noProjectRoot()` は `~/Documents/LeafCodePi`（クラッシュしない）

### 問題ないもの

- `dataDir()`（web/host）は Linux で `~/.leafcode-pi`。APPDATA は見ない
- Pi 既定 auth / アカウント auth、`~/.claude/.credentials.json`、`~/.codex/auth.json`
- 欠落 `auth.json` / `config.json` は null / `{}`（例外にしない）
- Host の WebUI 起動は Linux で `xdg-open`。トレイは Linux 既定オフ
- CodexBar `/api/codexbar/usage` はプロバイダ失敗でも 200 + empty（アカウント scope 不正のみ 4xx）

### OAuth とヘッドレス

GUI ブラウザは **WebUI を見ているクライアント**で `window.open`。コールバックサーバは **WebUI プロセスの loopback**。

| 構成 | 結果 |
| --- | --- |
| Linux デスクトップ、同じマシンのブラウザ | 可 |
| Tailscale IP だがブラウザがホスト上（localhost-redirect） | だいたい可 |
| SSH サーバ上の WebUI + 手元ブラウザ | 不可（callback が手元 localhost に着く） |
| ディスプレイ無しサーバ | URL コピー + ポートフォワード、または API キー |

偽アカウントでの実 OAuth 完了はしていない。

### テスト（Linux, Node v22.14.0）

Web 関連 36 files / **284 passed**（vitest、失敗 0）:

- `src/lib/codexbar`（app-paths / pi-auth / orchestrator / cookie / providers / config / cache ほか）
- `src/app/api/codexbar`（usage / providers / reset-credits）
- `src/app/api/accounts` + cookie ルート
- `src/app/api/providers`（login / base-url）
- `src/app/api/models/map`
- `src/components/codexbar`、`ProviderAuthPanel`、`TaskAccountBadge`
- `src/lib/accounts`、`auth-login`、`account-runtime-manager`、`cursor-provider`、`ollama-cloud-provider`
- `localhost-redirect`、`webui-auth`、`auto-model`

スモーク（秘密なし）: 欠落 `config.json` / `auth.json` で `loadCodexBarConfig()=={}`、`readPiOAuthTokens==null`、`GET /api/codexbar/usage?scope=default` が 200。実 OAuth は未実施。

Host 37 passed: `config` / `index` / `isolation` / `webui-auth`。`dataDir({})` = `~/.leafcode-pi`。Linux tray 既定オフ。

### ブランチ / PR

`cursor/linux-codexbar-paths-e138` / https://github.com/daihaya000/LeafCodePi/pull/9
実装 SHA: `6fb12c98` / 監査記録: `69f8abd3`

---

## 2026-09-14: Linux テスト隔離と provider-limit fallback 修正

master `c8fe752` の Ubuntu 検証で落ちていた host 3 + web 8 を修正。

### Host（フィクスチャ）
`web-build-mirror.test.js` が `C:\...` を生で渡し、Linux の `path.resolve` が cwd 相対にして `isMirrorNextStart` が不一致 → idle 誤判定。`os.tmpdir()` / `path.join` の実絶対パスに変更。LOCALAPPDATA / XDG_CACHE_HOME も同じ一時ディレクトリで検証。

### Web（隔離）
`test-environment.ts` が `LEAFCODE_PI_DATA_DIR` を削除し、`vitest.config.ts` は `APPDATA` だけ設定。Linux の `dataDir()` は APPDATA を見ないので `~/.leafcode-pi` → `assertTestSafe`。vitest に `LEAFCODE_PI_DATA_DIR` を足し、setup では消さない。`browse-paths` は store 書き込み先と一致するようテスト側でも設定。

### Web（実バグ）
`harness-limit-fallback` の 2s timeout はタイミングではなく、`refreshRuntimeClock` が置換セッションの未設定 `systemPrompt` に `.includes` して落ちていた。フォールバック再開（hidden custom turn）が error になり第2セッションへ prompt が届かない。未設定時は clock ブロックだけ入れる。

### 検証（Linux）
- host `web-build-mirror.test.js`: 37 pass
- web browse-paths 6 / bots route 2 / harness-limit-fallback 3 / harness-prompt 33 / harness-routing 23 / paths 4 = 71 pass

### ブランチ / PR
`cursor/linux-test-isolation-a602` / https://github.com/daihaya000/LeafCodePi/pull/8
実装 SHA: `226c6595`

---

## 2026-09-14: Bot Intercom Bridge Phase D

### 実装
無関係Botの混線防止とガード付き一斉送信。`intercomScopeId`（空欄=`default`）が同じBotだけ `list` / `list-cwd` / send / ask / fanout の対象。`list-cwd` は同スコープ名簿で、`cwd` 指定時は extraRoot または Bot workspace 一致で絞る。`fanout` は `intercomFanoutEnabled` 明示opt-in（既定OFF）、最大8件、受信fanoutの再放送禁止（`MAX_BOT_INTERCOM_FANOUT_DEPTH = 0`）、Roomターン拒否。メッセージ `v: 1` に任意 `scopeId` / `fanout` / `fanoutDepth`。

コア契約は維持: Bot id のみ / fromBot 詐称不可 / 深さ・ループ上限 / Room二重発火なし / opt-in + allowlist / 同一スレッド ask 往復 = MAX_ROOM_RELAY_DEPTH（3）。Roomリレー・opener・Auto・Computer は未変更。leafcode-intercom 本体コードは未変更（skill に Bot向けパターンを追加）。

### UI
内線設定カードにスコープ入力と一斉送信トグル（内線ON時のみ）。受信箱はCのまま肥やさない。

### 検証
bot-intercom 26 / bot-intercom-tool 12 / BotIntercomInbox 5 / BotView.code 57 / intercom route 3 / events 3 / room-runtime 42 / bots 21 / bots route 15 = 184 PASS。typecheck OK。

### 意図的に残した（E+）
confirmSend、wakeOnDm / Routine / 外部inbound、クロスマシン。fanout のネストAPIは作らない。

### ブランチ / PR
`cursor/bot-intercom-bridge-phase-d-603f`
実装 SHA: `c0c5ad08`

---

## 2026-09-14: Bot Intercom Bridge Phase C

### 実装
運用感の肉付け。presence（online/busy/offline）、Roomと同じ添付制限、`cancel` / `supersedes`（同一sender→recipientのみ）。忙しい常駐Botへのsendは `delivery: steered`。オフラインは従来どおり queued。既存の `notificationsEnabled` で内線未読増分をデスクトップ通知。メッセージ契約は `v: 1` のまま任意フィールド追加（`delivery` `attachments` `supersedes` `supersededBy` `retryOf` `cancelled`）。`confirmSend` は肥大化するため未実装（任意）。

コア契約は維持: Bot id のみ / fromBot 詐称不可 / 深さ・ループ上限 / Room二重発火なし / opt-in + allowlist / 同一スレッド ask 往復 = MAX_ROOM_RELAY_DEPTH（3）。

添付は Room と同じ: 画像 png/jpeg/webp/gif 最大8件 8MB、UTF-8テキスト最大8件 8MB。本体は `bots/.intercom/attachments/`、mailbox にはメタのみ。

### UI
受信箱に在席ドット（ラベルは title のみ、プレビューを食わない）、添付チップ、取消/差替。デバッグメタは行の `title` ホバーのみ（行ごとの「詳細」開示は出さない）。Room / opener / Auto / Computer / leafcode-intercom 本体は未変更。

### 検証
bot-intercom 21 / bot-intercom-tool 9 / BotIntercomInbox 5 / BotView.code 53 / intercom route 3 / room-runtime 42 / bots 21 / bots route 13 / events 3 = 170 PASS。typecheck OK。
デザニット後: BotIntercomInbox 5 / BotView.code 53 PASS。

### 意図的に残した（D+）
confirmSend、scopeId、fanout、wakeOnDm / Routine、クロスマシン。leafcode-intercom 本体は未変更。

### ブランチ / PR
`cursor/bot-intercom-bridge-phase-c-fcd9`
実装 SHA: `65813ca8` / デザニット: `a5d10b1b`

---

## 2026-09-14: Bot→Code ユーザー画像添付

### 問題
Bot会話にユーザーが付けた画像は Bot セッション / Room ディスクには届いていたが、`code_session` の start/prompt はテキストだけを Code に渡しており、Code は通常のユーザー添付と同じ画像を見ていなかった。

### 方針（bot-code-images.ts と同期）
1. Bot が `code_session.images` に 1-based index を渡したらその一覧だけを添付。`[]` は添付なし。
2. 省略時のデフォルト: **直近ユーザーメッセージの画像だけ**（最大8件）。会話全体は捨てない。
3. Goal Loop 開始は既存どおり添付不可。省略時は付けない（既存ループを壊さない）。明示指定 + goalLoop はエラー。
4. カタログ範囲: 1:1 = 現在ブランチのユーザー画像。Room = **今のユーザー依頼だけ**（新しいユーザー発言は別会話）。

### 実装
- `code_session` に `images` 引数。`projects` / `status` / 受付結果に `availableImages`（バイトは載せない）
- 解決した `{ mimeType, data }` を `CodeRequest.promptOptions.images` に保存し、`createTask` / `promptTask` へ通常のユーザー添付と同じ経路で渡す
- テキストのみ・lease / archived project / G5 承認はそのまま

### 検証
- bot-code-images 9 / bot-code-relay 62 / bots 21 / room-conversation 55 = 147 PASS
- 回帰: harness-bot-code 6 / harness-routing 23 / code-session route 15 / bot-code-session-lock 3 / room-runtime 42 / harness-prompt 32 = 121 PASS
- `npm --prefix web run typecheck` OK

### ブランチ / PR
`cursor/bot-code-image-attach-94ae` / https://github.com/daihaya000/LeafCodePi/pull/4
実装 SHA: `5f41c7e5` / 検証追記+型修正: `4446a675`

---

## 2026-09-14: Bot Intercom Bridge Phase B

### 実装
再起動後も未読が残る永続mailbox（`bots/<id>/intercom/mailbox.json`）と、Bot id 宛の `ask` / `reply` / `pending`。質問待ちはツール結果として返る。切断中の名前付きBotへの `send`/`ask` はmailboxにキュー。未読はサーバの `lastReadAt`（localStorage非依存）。

コア契約は維持: 宛先は Bot id のみ / fromBot 詐称不可 / 深さ・ループ上限 / Roomターン中は DM 拒否 / opt-in + allowlist / メッセージ `v: 1`（`kind` `conversationId` `replyTo` `queued` は後方互換の任意フィールド）。

同一スレッドの ask/reply 往復は Room と同じ `MAX_BOT_INTERCOM_ASK_ROUNDTRIPS = MAX_ROOM_RELAY_DEPTH`（3）。4回目の ask を拒否。reply の二重配送なし。相互 ask は元の ask が終わるまで拒否。

### UI
同じ受信箱にスレッド（直近）と「質問待ち」。Room / opener / Auto / Computer は未変更。

### 検証
bot-intercom 14 / bot-intercom-tool 7 / BotIntercomInbox 4 / BotView.code 51 / intercom route 3 / room-runtime 42 = 121 PASS。typecheck OK。

### 意図的に残した（C+）
presence、添付、cancel/supersede/confirmSend、scopeId、fanout、wakeOnDm / Routine、クロスマシン。leafcode-intercom 本体は未変更。

### ブランチ / PR
`cursor/bot-intercom-bridge-phase-b-21eb`
実装 SHA: `7b716d75`
---

## 2026-09-14: Bot Intercom Bridge Phase A

### 実装
Room外のBot同士1:1 DM。宛先は Bot id のみ（`stableId = botId`）。`send` のみ。送信者は実行中タスクの botId。深さは Room と同じ MAX=3。Roomターン中は DM 拒否（正式@は room_handoff のみ）。opt-in `intercomEnabled` 既定OFF + allowlist の `intercom` が双方必要。メッセージ `v: 1`。

### UI
BotView に受信箱（未読ドット + 誰/何1行）。Room UI と非混在。設定に「Bot間内線」トグル。

### 検証
bot-intercom 8 / bot-intercom-tool 4 / bots 21 / room-runtime 42 / bots route 13 / intercom route 3 / events 3 / BotIntercomInbox 3 / BotView.code 49 / harness-prompt 32 / RoomView 23 / rooms 12 / rooms route 1 = 214 PASS。typecheck OK。

### 意図的に残した（B+）
ask/reply/pending、永続mailbox、presence、添付、cancel/supersede、scopeId、fanout、wakeOnDm、クロスマシン。leafcode-intercom 本体（7d86dc0）は未変更。

### ブランチ / PR
`cursor/bot-intercom-bridge-phase-a-e6a2` / https://github.com/daihaya000/LeafCodePi/pull/3
実装 SHA: `70031d1a` / テスト修正+MEMORY: `f677801d`

---

## 2026-09-14: 進行中タスク分割で Bot が TaskView になる不具合

### 問題
Bot モードで「進行中タスクを分割」すると、本来 BotView（チャット + Code依頼カード）であるべき面が内部 TaskView として描画された。

### 原因
`349083d8` で Code/Bot の分割を共通化した際、旧 Bot 側は `codeInProgress` Bot を `/bots/<id>` タブで開いていた。共通化後は `kind=all` の生タスク ID（`bot:<id>` や Bot 紐づけ Code セッション）をそのまま `showWorkingTasks` に渡す。ホストは `isBotTabId`（`/bots/...` のみ）以外を TaskView に落とすため、Bot 会話タスクも Bot 起点 Code も TaskView 内部 UI になる。

### 修正
- `paneTabIdForTask` / `paneTabIdsForWorkingTasks`: Bot 会話・Room メンバー・Bot 所有 Code を `/bots/<id>` または `/bots/rooms/<id>` へ正規化
- Sidebar / TaskPanesHost の分割収集で上記を使用（同一 Bot の会話+Code は1タブに畳む）
- ホスト描画は `isBotSurfaceTabId` で `bot:` 残タブも BotView/RoomView
- `isBotTabId` と Room opener / Auto / BOT_INTERCOM_BRIDGE は未変更

### 検証
task-panes.bot 9 / task-panes 84 / TaskPanesHost 9 / Sidebar.bot-rail 14 / Sidebar.project-order 19 / TaskPanesContext 17 = 152 PASS

### ブランチ / PR
`cursor/bot-split-keeps-botview-8e17` / https://github.com/daihaya000/LeafCodePi/pull/2

---

## 2026-09-13: Room 正式 @mention pill → 暗黙 room_handoff

### 問題
Bot Room でアシスタントが UI の `@デバッガー` チップを出してもサーバに何も登録されず、相手が起きない。起床は `room_handoff` / `ROOM_ACTION: NEXT` のみ。Auto / Room opener は対象外。

### 修正
- `formalRoomMemberMentions` / `withImplicitRoomMention`: UI チップと同じ `@名前|id`（語境界・ひらがな接尾、フェンス除外）。地の名前は無視
- `bindImplicitMentionHandoff`: 同一ターン1件を既存 `registerRoomHandoff` へ。明示 NEXT / 既存 tool handoff 優先
- 暗黙は `botRelayEnabled` なしでもサーバ起点で配信。クライアント envelope spoof 検証は未変更
- 登録失敗時は `lastOutcome.kind = mention`（サイレント完了しない）
- 深度・ループは既存リレーと同じ

### 変更ファイル
`room-conversation.ts`, `room-runtime.ts`, `rooms.ts`, `types.ts`, `room-handoff-tool.ts`, `RoomView.tsx`, `docs/bot-room-conversations.md` + テスト

### 検証
room-conversation 55 / room-runtime 42 / rooms 12 / prompt route 51 = 160 PASS。typecheck OK。

### ブランチ / PR
`cursor/room-mention-implicit-handoff-952a` / https://github.com/daihaya000/LeafCodePi/pull/1
実装 SHA: `28fb0973`

---

## 2026-09-10: バグハント loop — Ctrl+Enter / room signature / goal-loop resume

### 修正・改善
1. **UX**: Bot/Room 送信を Ctrl/Meta+Enter に変更（Enter は改行）。候補確定は修飾キーなし Enter のみ（送信と衝突回避）
2. **MED**: `roomSnapshotSignature` に `codeRequests` 指紋を追加（同一 ms の Code 状態遷移を取りこぼさない）
3. **MED**: goal-loop の session resume で `verifying_completed` を running と同様に強制 pause しない。lifecycle pause の `pauseReason` は `""`（user pause と区別）

### 検証
BotComposer 5 / BotView.code 21 / RoomView 16 / room-events 4 / goal-loop 30 PASS

---

## 2026-09-10: バグハント — 並列 Room Code の codeActivity 消失

### 修正
**MED**: 未コミットの並列 Code 対応で、`save()` が他リクエスト更新時にも `codeActivity` を空にしていた（[Hunt bugs beyond recent fixes](4d10e206)）。所有者かつ starting/running 以外への遷移時だけクリアするよう変更。キュー前提テストを並列動作に更新。

### 検証
bot-code-relay 46 PASS / typecheck OK

---

## 2026-09-10: バグハント loop tick4 — processKey 無し lock の年齢 stale

### 修正
**MED**: `stateLockIsStale` が `processKey` 欠如時に live PID だけで lock を残し、PID 再利用で解放不能になり得た → `createdAt` 超過で stale。回帰テスト追加。

### 検証
`workflow-state.test.ts` 1 PASS

---

## 2026-09-10: バグハント loop — RoomView SSE reconnect 積み上げ

### 修正
**MED**: RoomView `onerror` が既存 retry をキャンセルせず EventSource が多重化し得た → BotView と同型で `cancelPendingSseReconnect` / `closeSseSource` / `sseReconnectDelayMs` を使用（[Hunt fresh medium bugs](d1997ba8)）。agents POST/DELETE reload は d8bdbf0 で対応済み。

### 検証
RoomView 15 / sse-reconnect PASS

---

## 2026-09-10: バグハント loop tick — Room切替残留 / agents reload

### 修正
1. **HIGH**: Room 切替で前ルームの会話が残る（BotView と同型）→ `id` 変更時に room/attention 等をクリア
2. **MED**: POST/DELETE `/api/agents` が `reloadLiveSessionsContext` を呼ばず、作成・削除がライブセッションに遅延反映 → PATCH と同様に reload

### 検証
RoomView 15 / agents route 12 / [name] route 4 PASS

---

## 2026-09-10: バグハント継続 — Bot切替残留 / agents tools・Effort

### 修正
1. **HIGH**: Bot 切替で前会話が残る → `id` 変更時に messages/permission/question 等をクリア（[Hunt next medium bugs](9da25c68)）
2. **MED**: POST create の `toArray([])` が空 tools を消す → 空配列を保持
3. **MED**: `emptyDraft` の4ツール明示 allowlist が既定表示と不一致 → tools 未指定に変更（[Find and prove one bug](14fcb708)）
4. **MED**: 編集画面の Effort 自由入力 → `AgentEffortPicker` に統一（API 側検証は既存）

### 検証
BotView.code 20 / agents route 12 / AgentsSettings 13 PASS

---

## 2026-09-10: バグハント継続 tick — attention contentKey churn

### 根本原因
`RoomView` の `chatScrollKey` useMemo が `attention` 配列参照を依存にしていたため、SSE 毎に内容同一でも新しい contentKey オブジェクトが生まれ、追従中の不要な scroll layout read が残っていた（messages 安定化だけでは不足）。`BotView` も `routines` 配列参照依存で同様。

### 修正
- Room: attention を id 指紋で安定化し、`attentionScrollKey` 文字列を useMemo 依存に変更
- Bot: `routineFailuresKey` 文字列を useMemo 依存に変更
- 回帰: 安定 contentKey 再利用で読了位置を保つテスト追加

### 検証
BotMessageList 16 + RoomView 15 PASS

---

## 2026-09-10: Bot/Room スクロール回帰 + lock fail-open バグハント

### 根本原因と修正
1. **MED-HIGH（019aeea 回帰）**: `BotMessageList` の `contentKey={messages}` だけでは、SSE で `permission` / `question` / 応答中 UI が出ても追従スクロールしない（messages 参照は `stabilizeUiMessages` で安定しうる）。→ `BotView` / `RoomView` でオーバーレイ込みの `chatScrollKey`（useMemo）を渡す。
2. **MED**: Room SSE が毎回新 `messages` 配列を渡すため、内容同一でも scroll layout read が走る。→ `stabilizeIdentifiedList` を汎用化し `applyRoomSnapshot` で参照安定化。
3. **MED**: `workflow-state` の `stateLockIsStale` が他 PID の `processKey` 照合失敗時に fail-open → PID 再利用で lock が残る。→ 照合失敗は stale（fail-closed）。ロック取得時の `currentProcessKeyFor()` 二重呼び出しも解消。
4. **MED**: `answerQuestion` に try/catch がなく API 失敗が UI に出ない。→ Bot/Room とも `respond` と同型のエラー表示。

### 検証
- `BotMessageList.test.tsx` 15 PASS（overlay contentKey 追従ケース追加）
- `stabilize-messages.test.ts` 21 PASS（Room 相当の identified list 安定化）
- `RoomView.test.tsx` 15 PASS
- `npm --prefix web run typecheck` OK

### 残存リスク
- `stateLockIsStale` は非 export のため専用単体テスト未追加（fail-closed はコードレビューで確認）
- `answerQuestion` 失敗時の回帰テストは未追加（既存成功パスは維持）

---

## 2026-09-05: commit-guard / settle / todowrite 追加バグ修正

### 修正した具象バグ
1. **HIGH**: Pi jiti (`moduleCache: false`) で settle-followup-claim のモジュール状態が拡張間で共有されず二重 follow-up し得た → `Symbol.for` + `globalThis` に移行
2. **HIGH**: 旧 extensions-state disabled の migrate が Web のみで、エージェントは既定 ON のままゲート発火 → 拡張側 `isCommitGuardFeatureEnabled` でも one-shot migrate
3. **MED**: feature-off 時に git 観測までスキップし、再ONで sticky hard 偽陽性 → settle では baseline 維持し、同一 porcelain では sticky を消す
4. **MED**: `settle-followup-claim.ts` が拡張として発見され factory エラー → discovery / filter から除外（共有モジュール扱い）
5. **MED**: 設定 GET 失敗時に UI が「有効」のまま操作可能 → `enabled=null` / 「不明」+ Switch disabled

### 検証
vitest 80 PASS（commit-guard 25 + todowrite 16 + settle + settings/extensions）

---

## 2026-09-05: コミットガードは拡張常時ON・機能だけOFF

### 問題
設定でコミットガードをオフにしても、`agent_settled` 後に `leafcode-commit-gate` follow-up（コミット促し）が送られていた。

### 原因
1. 以前の設定UIは拡張の load/unload（`extensions-state.json` の disabled）を切り替えていた。
2. その後 `leafcode-commit-guard` が WebUI 必須になり、disabled でも常時ロードされる一方、一覧/UIは無効表示のままになり得た。
3. 機能トグル用の設定ファイルが無く、拡張内ゲートが常時動作していた。

### 修正
- **拡張は必須のまま**（無効化不可）
- 機能フラグは `%APPDATA%/leafcode-pi/commit-guard.json`（`{ "enabled": boolean }`、既定 true）
- WebUI: `/api/settings/commit-guard` + エンジン設定のトグル
- `leafcode-commit-guard` は settle 時にフラグを読んで follow-up を抑制
- 古い `extensions-state` の disabled は初回読込で機能OFFへ移行し、disabled キーを掃除
- `settle-followup-claim`: 同一ターンの二重 `prepare` を microtask ラッチで合流

### 関連
- `web/src/lib/commit-guard-config.ts`
- `extensions/leafcode-commit-guard/index.ts`
- `extensions/settle-followup-claim.ts`
- `extensions/leafcode-todowrite`（commit-gate ターン中の Todo 強制スキップは従来どおり）

---

## 2026-09-05 — settle-followup-claim を WebUI 依存に追加

- `isWebUiRequiredExtension` に `WEBUI_REQUIRED_EXTENSION_NAMES`（`settle-followup-claim`）を追加。leafcode- 接頭辞なしでも無効化不可。
- todowrite / commit-guard の settle 排他モジュールが拡張一覧から OFF できない。
- テスト・README を更新。

---

## 2026-09-05 — leafcode-commit-guard を WebUI 依存に固定

- `web/src/lib/extensions.ts` の `OPTIONAL_LEAFCODE_EXTENSIONS` から `leafcode-commit-guard` を除外（空 Set）。
- `isWebUiRequiredExtension("leafcode-commit-guard") === true` となり、拡張機能画面で「WebUI が依存するため無効化できません」表示・トグル OFF 不可。
- `CommitGuardSettings` も同様にロック表示へ変更。
- 関連テスト・README を更新済み。

---

## 2026-09-05 — settle-followup-claim.ts 用途

- 役割: `leafcode-todowrite` と `leafcode-commit-guard` が `agent_settled` で送る follow-up を、1 サイクルにつき 1 本だけにする共有クレーム
- 流れ: 各拡張が `agent_end` で `prepareSettleFollowUpClaim()` → settle 時に `isSettleFollowUpClaimed()` でスキップ判定 → `sendMessage` 成功後に `markSettleFollowUpClaimed()`
- 背景: `hasPendingMessages` は `triggerTurn` 即実行では効かないため、モジュール共有の epoch カウンタで排他

---

## 2026-09-05 — commit-guard ループ終了（tick 9–13）

- 最終監査: **NO_CLEAR_BUGS_REMAINING**（回帰 41/41 PASS）
- 残低リスクのみ: シェルヒューリスティック未網羅×unknown baseline、settle claim による他ゲート1サイクル遅延（設計）
- 2分ループ（PID 35516 / `AGENT_LOOP_TICK_commit_guard_bugs`）を停止

---
## 2026-09-05 — commit-guard ループ tick 7-8

- reload/resume で start の git が失敗しても合成 baseline（`initiallyDirty=false`）を適用
- pre-tool snapshot 失敗時は in-flight で post-mutation dirty を baseline にしない
- `hasPendingMessages` は triggerTurn 即実行のため無効 → `extensions/settle-followup-claim.ts` で todowrite と排他
- todowrite も enqueue 失敗時は reminderSent を立てず再試行
- 検証: commit-guard 22 + todowrite 16 = 38 PASS

---
## 2026-09-05 — commit-guard ループ tick 6

- **二重 follow-up**: todowrite gate が先にキュー済みのとき `ctx.hasPendingMessages()` で commit-gate を延期（次 settle で再試行）
- **soft ヒューリスティック**: `git pull` / `am` / `revert` を mutating shell に追加
- 検証: commit-guard 20/20 PASS

---
## 2026-09-05 — commit-guard ループ tick 2+: late soft FN

- **修正**: 最初の mutating `tool_call` 前に porcelain をスナップショット。遅い `session_start` が post-mutation dirty を baseline にしない。
- idle な `session_start` 再入場では旧 baseline をクリアし、tool_call が勝った場合は上書きしない（`adoptBaseline`）。
- 検証: commit-guard 18/18 PASS（clean tree + soft 競合の回帰を追加）

---
## 2026-09-05 — commit-guard 残存バグ修正（ループ tick 1）

監査で挙がった明確バグを実装側で除去。検証: `vitest` commit-guard 17 + CommitGuardSettings 3 = 20 PASS。

### 修正
1. **baseline 復帰 FP**: fingerprint が `initialStatusText` に戻ったら sticky hard/soft をクリア（未 reminder の hard+不変 porcelain は例外で1回ゲート）
2. **reload/resume FN**: `reason` が reload/resume かつ dirty なら `initiallyDirty=false` + 合成空 baseline で再マウント後もゲート
3. **unknown baseline + soft FN**: `initiallyDirty === undefined` 時は softMutation でも発火
4. **sendMessage 失敗 FN**: 成功時のみ `reminderSent` を立て、失敗後は再 settle で再試行
5. **並行 settle**: `gateRunning` + 最新 ctx キューで単発化
6. **未知ツール FP**: hard は edit/write/subagent のみ。未知は soft（fingerprint 主）
7. **Settings UI**: 初期 `enabled=null`（読込中）、GET 失敗でも `loaded` + エラー表示

### 既知の残り
- late `session_start` と soft が競合し、もともと clean だった tree の soft-only が probe 結果に吸収される FN（pre-dirty FP 回避とのトレードオフ）

### ファイル
- `extensions/leafcode-commit-guard/index.ts`
- `extensions/leafcode-commit-guard/index.test.ts`
- `web/src/components/settings/CommitGuardSettings.tsx`
- `web/src/components/settings/CommitGuardSettings.test.tsx`

---
## 2026-09-05 — commit-guard 残存バグ監査

監査対象: `extensions/leafcode-commit-guard`、todowrite 連携、`CommitGuardSettings`、`OPTIONAL_LEAFCODE_EXTENSIONS`。
既修正（unknown git=clean、late session_start の initiallyDirty=false 強制、soft 単独 on pre-dirty、reminderSent 再武装）以外の残件。

### 明確な誤動作（Clear）
1. **HIGH FP**: 事前 dirty + hard 編集 → gate → タスク分だけ commit して fingerprint が baseline に戻ると、`hardMutationObserved` が sticky のまま + re-arm で再発火（`runCommitGate` 167-180 / `shouldRequestCommitGate`）。
2. **HIGH/MED FN**: `session.reload()`（拡張トグル・skill 権限変更等）で拡張が再マウントされフラグが初期化。dirty 作業中の reload は現在 dirty を新 baseline にし、以降の settle が無発火。
3. **MED FN**: 遅い `session_start` + soft が先に tree を dirty 化 → in-flight 分岐が post-mutation status を baseline に固定 → soft-only の clean→dirty が落ちる。
4. **MED FN**: `session_start` の git 失敗で `initiallyDirty`/`initialStatusText` が undefined のまま → statusChanged 不能、soft も無視。
5. **MED FN**: `reminderSent=true` を `sendMessage` 成功前に立てるため、enqueue 失敗後は fingerprint 変化まで再送しない。
6. **MED race**: 並行 `runCommitGate` に in-flight ロック無し → 二重 follow-up 可。
7. **MED FP**: 未知ツール名はすべて hard（`classifyRepoMutation`）。pre-dirty + porcelain 不変でも発火。
8. **LOW UI**: `CommitGuardSettings` の GET 失敗時 `loaded` が立たず Switch が永久 disabled。ロード前に「有効」表示フラッシュ。

### 推測（Speculative）
- 同一 settle で commit-gate と todowrite-gate が両方 enqueue。
- reload 中に旧 runner の非同期 `runCommitGate` が残る。
- clean start の「any dirt」は外部/IDE 編集でも発火（コメント上は意図、文言は overclaim）。

### 欠測テスト
- baseline 復帰後に hard sticky で再発火しないこと
- reload/session_start remount 後もタスク差分を失わないこと
- late start + soft on originally-clean
- git 失敗 baseline + soft dirt
- sendMessage 失敗後の再試行
- 並行 settle の単発化
- 未知 read-ish ツールが pre-dirty で FP しないこと
- CommitGuardSettings の load 失敗 UX

---
## 2026-09-05 — コミットガードを設定から無効化

- **要望**: コミットGUARDを設定画面から無効化できるようにする。
- **原因**: `isWebUiRequiredExtension()` が全 `leafcode-*` を WebUI 必須扱いし、拡張一覧でも無効化できなかった。
- **対応**:
  - `leafcode-commit-guard` を optional 例外に追加（`web/src/lib/extensions.ts`）。
  - 設定 → エンジン → アクセスと安全 に「コミットガード」スイッチ（`CommitGuardSettings`）を追加。
  - 内部は既存の `/api/extensions/:name` PATCH + `extensions-state.json` を再利用し、開いているセッションへ即時反映。
- **既定**: 有効。無効化すると拡張がロードされず、未コミット時のフォローアップは出ない。

---
## 2026-09-05 — commit-gate 偽陽性/偽陰性の修正

### 根本原因
1. `git status` 失敗（timeout/kill/非0）を clean 扱いし、`mutationObserved` / `reminderSent` を消していた（OneDrive で起きやすい偽陰性）
2. 遅い `session_start` が in-flight 時に `initiallyDirty=false` へ押し下げ、事前 dirty + soft shell（npm 等）で偽陽性ゲート
3. soft ヒューリスティック単独で事前 dirty ツリーでも発火していた（fingerprint 主信号と矛盾）
4. `reminderSent` が全 clean まで張り付き、部分 commit 後の新規差分で再武装しなかった

### 修正
- unknown status は early-return（フラグを触らない）。`killed` も失敗扱い。timeout 15s
- hard（edit/write/subagent）と soft（shell ヒューリスティック）を分離。事前 dirty は fingerprint 変化 or hard のみ
- late `session_start` は in-flight フラグを保持し、`initiallyDirty` を false 強制しない／baseline を上書きしない
- clean 成功時は baseline を同期。reminder 後に fingerprint が動いたら再武装

### 検証
`npx --prefix extensions/leafcode-todowrite vitest run --dir extensions/leafcode-commit-guard` → 10/10 PASS

### ファイル
- `extensions/leafcode-commit-guard/index.ts`
- `extensions/leafcode-commit-guard/index.test.ts`

---
## 2026-09-05 — エージェント一覧の二列表示

- 設定画面のエージェント（subagents）一覧を、拡張機能一覧と同じく `grid gap-2 sm:grid-cols-2` に変更した。
- 対象: `web/src/components/settings/AgentsSettings.tsx`
- テスト: `AgentsSettings.test.tsx` で `sm:grid-cols-2` を検証。
- 併せて CodexBar の二列グリッドを `items-start` → `items-stretch` に揃え（カード高さ揃え）。

---

## 2026-09-05 — Codex 使用量リセット権 UI

ChatGPT Codex の banked rate-limit reset（リセット権）を CodexBar から確認付きで消費できるようにした。

### 要点
- `/wham/usage` の `rate_limit_reset_credits.available_count` を `CodexBarProvider.resetCreditsAvailable` に載せる
- BFF: `GET/POST /api/codexbar/reset-credits`（WHAM list/consume、アカウント単位 OAuth）
- UI: Codex 行の展開時に「リセット権 N」「使う」→ confirm → consume → usage 再取得
- 自動消費はしない（不可逆のため手動確認のみ）

### 主要ファイル
- `web/src/lib/codexbar/providers/openai-codex.ts` — usage パース + WHAM auth 解決
- `web/src/lib/codexbar/providers/openai-codex-reset.ts` — list/consume アダプタ
- `web/src/app/api/codexbar/reset-credits/route.ts` — BFF
- `web/src/components/codexbar/CodexBarWidget.tsx` — UI

---

## 2026-09-05: high-usage ループ tick 57 — 圧縮中の follow-up drain/auto-send

- バグ: `shouldDrainQueuedFollowUp` / `shouldAutoSendQueuedFollowUp` が `compacting` を見ず、submit は compacting で no-op → キュー項目が消え composer に取り残され得た（silent resume は既に抑止）
- 修正: drain/auto-send に `compacting` ゲートを追加し TaskView から渡す
- 検証: `queued-follow-up.test.ts` 18/18 パス
- 備考: この tick で 2 分バグ狩りループを停止

---

## 2026-09-05: high-usage ループ tick 56 — hang_idle が SSE ready バッファで破棄される

- バグ: `hang_idle` が control イベント集合に無く、ready 後 flush で履歴が古ければ破棄され、再接続中に idle 遷移がクライアントへ届かない
- 修正: `hang_idle` を `SSE_CONTROL_SNAPSHOT_EVENT_TYPES` に追加。手動 abort でも `isStreaming:false` を明示
- 検証: `sse-ready-buffer.test.ts` + `harness-agent.test.ts` 31/31 パス

---

## 2026-09-05: high-usage ループ tick 54-55 — hang_abort後の偽working残留

- バグ: hang watchdog abort が idle を SSE せず、かつ `toSummary` が残存 isStreaming で status を working に押し上げ、クライアントが busy のまま残り得た
- 修正: `hang_idle` スナップショットを追加、`hang_abort` で isStreaming:false。`resolveSummaryStatus` は idle/error/archived を再昇格しない
- 検証: harness-agent / harness-prompt / queued-follow-up 59/59 パス

---

## 2026-09-05: high-usage ループ tick 52-53 — abort後のthrottled deltaとhang retryの誤followUp

- バグ: Stop/hang_abort 後も pending snapshot タイマーが pre-abort の `isStreaming:true` delta を送り得た。また hang retry が残存 isStreaming で followUp 注入され得た
- 修正: `cancelPendingTaskSnapshot` で abort 時にタイマー破棄。`buildPromptOptions` は hang retry に followUp を付けない
- 検証: `harness-prompt.test.ts` 22/22 パス

---

## 2026-09-05: high-usage ループ tick 51 — 偽workingのsteer黙殺とidle後の偽isStreaming

- バグ: ターン終了後に status が working のまま残ると steer が wait→drop で消える。また idle 後の古い isStreaming:true デルタでクライアントが busy 扱いになる
- 修正: promptActive が無い steer は通常プロンプトへ降格。`mergeTaskDelta` は status≠working なら isStreaming を無視
- 検証: `harness-prompt.test.ts` + `task-delta.test.ts` 24/24 パス

---

## 2026-09-05: high-usage ループ tick 50 — Stop後の古い isStreaming で stopRequested 解除

- バグ: abort 後に遅延した `isStreaming:true` デルタで複合 `working` が点灯し、`shouldClearStopRequestedOnWorkingTransition` がラッチを解除 → キュー drain/auto-send が再開し得た
- 修正: ラッチ解除を `task.status === "working"` 遷移のみに限定（stale stream ではクリアしない）
- 検証: `aborted-resume.test.ts` + `queued-follow-up.test.ts` 35/35 パス

---

## 2026-09-05: high-usage ループ tick 46-49 — クライアントがストリーム前 steer を通常送信

- バグ: UI の `isSteer` が `isStreaming` のみ参照し、`prompt_accepted`〜stream 間の割り込みが `streamingBehavior` なしで POST → 通常 promptChain 化
- 修正: `shouldSendSteerBehavior` / optimistic 判定を `working` 基準に（サーバ側 wait と接続）
- 検証: `queued-follow-up.test.ts` 16/16 パス

---

## 2026-09-05: high-usage ループ tick 41-45 — ストリーム開始前の steer が通常プロンプト化

- バグ: `prompt_accepted` 後で `isStreaming` 前の steer が promptChain に載り、ターン終了後の通常プロンプトとして実行され得た
- 修正: steer/followUp は常に chain bypass、`waitForSessionStreaming` でストリーム開始を待ち、開始しなければ drop。UI も `isStreaming` 基準で steer 判定
- 検証: `harness-prompt.test.ts` + `queued-follow-up.test.ts` 35/35 パス

---

## 2026-09-05: high-usage ループ tick 40 — SSE再接続で hang_abort 取りこぼし

- バグ: リスナー0件の間に `hang_abort` が drop され、クライアント queue が残り hang resume と二重送信し得た
- 修正: ready 等で `manualAbortedAssistantId != null` なら queue クリア、drain/auto-send は hydrating/reconnecting 中も抑止
- 検証: `queued-follow-up.test.ts` 15/15 パス

---

## 2026-09-05: high-usage ループ tick 36-39 — hang_abort が sentinel より先に emit

- バグ: `abortLiveForHangWatchdog` が persist 前に `hang_abort` を送り、SSE flush で `manualAbortedAssistantId: null` が正しい `""` を上書きし再開 UI が消える
- 修正: 手動 abort と同様に persist → emit → session.abort の順へ
- 検証: `harness-agent.test.ts` 20/20 パス

---

## 2026-09-05: high-usage ループ tick 33-35 — 早期 abort sentinel の早期クリア

- バグ: `queuePrompt` 先頭で `manualAbortedAssistantId` を null にするため、epoch 失効や prompt 失敗後に `""` sentinel が消え再開 UI が消える
- 修正: クリアを `session.prompt` 直前に移し、開始前失敗時は以前の sentinel を復元
- 検証: harness-agent / harness-revert / aborted-resume 50/50 パス

---

## 2026-09-05: high-usage ループ tick 30-32 — silent resume × queue 二重 POST

- バグ: silent 終了の idle 遷移で自動再開と queued follow-up drain/auto-send が同時発火し `/prompt` が二重送信され得た
- 修正: キュー優先で silent auto-resume を抑止、drain/auto-send/submit は `resumingTurn` 中も抑止
- 検証: `aborted-resume.test.ts` + `queued-follow-up.test.ts` 32/32 パス

---

## 2026-09-05: high-usage ループ tick 26-29 — steer 後の optimistic ゴースト行

- バグ: steer 送信でも `pendingUserMessage` を立て、履歴に user が増えないため成功後もタイムライン末尾にゴースト行が残る
- 修正: steer 時は optimistic user 行を出さない（`shouldShowOptimisticPendingUser`）
- 検証: `queued-follow-up.test.ts` 11/11 パス

---

## 2026-09-05: high-usage ループ tick 21-25 — 早期 abort で自動圧縮が止まらない

- バグ: 応答前 Stop で `manualAbortedAssistantId === ""` なのに truthy 判定のため `scheduleAutoCompaction` が圧縮を実行し再開可能なターンを壊し得た
- 修正: `blocksAutoCompactionAfterManualAbort`（`!= null`）で空文字 sentinel もブロック
- 検証: `aborted-resume.test.ts` 18/18 パス

---

## 2026-09-05: high-usage ループ tick 18-20 — control flush の履歴巻き戻し

- バグ: ready 後に flush する control snapshot がバッファ時点の古い `messages` を載せたまま送られ、TaskView がタイムラインを巻き戻す
- 修正: `preparePendingPayloadForReadyFlush` で ready より古ければ messages/todos/contextUsage を除去してから送信
- 検証: `sse-ready-buffer.test.ts` + `events/route.test.ts` 19/19 パス

---

## 2026-09-05: high-usage ループ tick 14-17 — Goal Loop 開始後の旧 hang watch

- バグ: `goalLoopCommand` が `queuePrompt` を経由せず、直前チャットの hang watch が残り旧プロンプトで resume → Goal が abort で一時停止
- 修正: `session.prompt` 直前に `disarmTaskHangWatch(taskId)`
- 検証: `hang-watchdog.test.ts` + `goal-loop/route.test.ts` 16/16 パス

---

## 2026-09-05: high-usage ループ tick 11-13 — hang が権限待ちを誤 abort

- バグ: hang watchdog が permission/question 待ちを無応答とみなし、`clearPendingAttentionForTask` で承認を自動拒否
- 修正: `hasPendingAttention` 中は hang 判定をスキップし進捗時刻を更新
- 検証: `hang-watchdog.test.ts` 11/11 パス

---

## 2026-09-05: high-usage ループ tick 8-10 — ready が解決済み権限を復活

- バグ: ready が `detail.permissionRequest ?? live` で、取得中に解決済みでも古い要求オブジェクトを優先（pair-cancel 後は resolved も無いためゴーストダイアログが残る）
- 修正: bootstrap と同様、ready 送信直前の live pending のみ使用
- 検証: `events/route.test.ts` 8/8 パス

---

## 2026-09-05: high-usage ループ tick 6-7 — stopRequested ラッチ残留

- バグ: abort 成功後も `stopRequested` が true のまま → Goal Loop 再開などで再 working 時に Stop が無効・`abortWorking` 即 return
- 修正: idle→working 遷移でラッチ解除 + goal-loop resume 成功時も解除（自動再開抑制は idle 中は維持）
- 検証: `aborted-resume.test.ts` 17/17 パス

---

## 2026-09-05: high-usage ループ tick 5 — ready 後の tip delta 巻き戻し

- バグ: `shouldFlushPendingAfterReady` が同一 createdAt・異なる id（msg-N vs entry id）の delta を flush し、`upsertUiMessage` の renderKey 経由で先端が巻き戻る
- 修正: id 相違のみでは flush / fresher とみなさない
- 検証: `sse-ready-buffer.test.ts` + `events/route.test.ts` 17/17 パス

---

## 2026-09-05: high-usage ループ tick 4 — abort 失敗でキュー消失

- バグ: `abortWorking` が API 呼び出し前に queued follow-ups を消し、失敗時は `stopRequested` だけ戻してキューは空のまま
- 修正: キュークリアを abort 成功後に遅延（リクエスト中は `stopRequested` が drain を阻止）
- 検証: `queued-follow-up.test.ts` 10/10 パス

---

## 2026-09-05: high-usage ループ tick 3 — abort 後の queued follow-up 自動送信

- バグ: SSE `abort` ではクライアントの queued follow-ups を消さず、idle になると auto-send（`hang_abort` / ローカル Stop とは非対称）
- 修正: `shouldClearQueuedFollowUpOnEvent` に `"abort"` を追加
- 検証: `queued-follow-up.test.ts` 10/10 パス

---

## 2026-09-05: high-usage ループ tick 2 — SSE permission pair cancel

- ループ: 旧 PID 37224 が aborted → PID 31976 で再起動
- バグ: ready 前バッファが `permission_request` / `permission_resolved` を打ち消さず、ゴーストダイアログや新リクエスト消失が起き得た（question_* も同様）
- 修正: `sse-ready-buffer.ts` で request↔resolved をペアキャンセル
- 検証: `sse-ready-buffer.test.ts` + `events/route.test.ts` 16/16 パス

---

## 2026-09-05: high-usage ループ tick 1 — permission silent deny

- ループ: `AGENT_LOOP_TICK_highusage_bugs`（2分間隔、PID 14868）開始
- バグ: sessionId→taskId 未解決時、`permission-prompt.handleRequest` が `false`（ユーザー拒否）を返していた
- 影響: WebUI に確認ダイアログが出ず、permission-gate が「Blocked by user」と誤表示
- 修正: `null`（no UI）を返すよう変更（`question-prompt` と同セマンティクス）
- 併せて空 sessionId は bridge 側で即 `null`、`resolveTaskIdFromSession` も空文字を拒否
- 検証: `permission-prompt.test.ts` 7/7 パス

---

## 2026-09-05: git log を安全ガードから除外

- 原因: ask モード `DANGEROUS_PATTERNS` の `\bsudo\b` 等が `git log --grep=sudo` に誤ヒット
- 対応: 読み取り専用 git（`git log` / `git show` 等）を system-safety・dangerous・`.git` 保護パス緩和から除外
- `git push --force` / `git reset --hard` は従来どおり検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 45

- FP: `command -v growfs|resize2fs|…`（soft-prefix が `-v` を食う）→ `-v`/`--help`/`--version` を wrapper 引数から除外
- FN: `cryptsetup open|luksOpen`（close と対称）、`lvextend|lvreduce|lvcreate|pvcreate|vgcreate|lvchange|vgchange`、`tune2fs`
- help: resize 系 `--help` を非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 44

- FN: `zfs rollback`、`geom … destroy`、`growfs`/`tunefs`/`resize2fs`/`xfs_growfs`/`lvresize`/`pvresize`
- FN: `dmsetup remove`、`losetup -d`、`camcontrol eject`、`cryptsetup close|luksClose`
- FP: `zfs|zpool destroy -n`（dry-run）
- RAID show/config 読み取りは過検知なし（確認済み）

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 43

- FN: `geli init|attach|detach`、`bsdlabel -w|-R`、`glabel destroy|create`、`gpart add`、`newfs_ufs`
- FN: `arcconf`/`ssacli`/`hpacucli` 破壊操作
- FP: bare `diskshadow` → `/s` 必須、`newfs -N` dry-run 除外

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 42

- FN: FreeBSD `camcontrol format` / `gpart destroy|delete|create` / `newfs`、`diskshadow`、`Remove|New|Resize-VHD`
- FN: disk soft-prefix に `ssh|docker|podman|wsl|…`（ホスト引数含む）を拡張
- FP: `diskpart list|select vdisk`

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 41

- FN: `storcli`/`perccli`/`MegaCli` の erase/secureerase/CfgLdDel/del force/init full
- FN: `hdparm --security-erase`（デバイス省略含む）、`fsutil volume format`
- FP: `cipher /w:… /?`（ヘルプ）

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 40

- FN: `smartctl --sanitize`（status 除外）、`sg_sanitize`、`Remove-StoragePool|Remove-VirtualDisk`
- FN: `defrag /W`、`Optimize-Volume -WipeFreeSpace`、`sdelete -z|-c`（cipher /w 同系）
- FP: `format C: /?` 等ドライブ文字付き help

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 39

- FN: `badblocks -w`、`Reset|Clear-PhysicalDisk`、`Clear-FileStorageTier`、`hdparm --security-set-pass|--user-master-password`
- FP: `sg_format --inquiry|--version`（破壊フラグ必須に絞り込み）、`dd if=/dev/zero of=image.img`（`of=` がシステムパスのときのみ）、`diskpart select …`

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 38

- FN: `nvme format|sanitize|delete-ns`、`sg_format`（disk）
- FP: `diskpart list disk|volume|partition`（読み取り専用）を除外；`nvme list` / help も非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 37

- FN: `swapoff` / `mkswap` / `blkdiscard`（disk、VAR=val・busybox soft-prefix 対応）
- help / `echo swapoff` は非検知
- 調査: Windows `Remove-Item C:\Windows` は既に system path mutation で standard ゲート済み；low===standard 差分なし

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 36

- FN: `FOO=1` / `env FOO=1` 前置きが security・disk tail・launchctl をすり抜け → VAR=val soft-prefix 統一
- FN: `zfs destroy` / `zpool destroy` / `btrfs subvolume delete` / `xfs_repair -L`（disk）
- FN: `Remove-MpPreference -ThreatID*`（security software disable）
- list / `-L` なし xfs_repair は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 35

- FN: `launchctl bootstrap|load|enable|…` を scheduled（standard）に昇格パリティ
- FN: `vgremove`/`lvremove`/`pvremove`、`cryptsetup luksFormat|luksErase|…`（disk）
- FN: `Remove-WindowsCapability` / `Remove-WindowsFeature Windows-Defender`、`Set-MpPreference -EnableControlledFolderAccess Disabled`

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 34

- FN: `Disable-WindowsDefender` / `Uninstall-WindowsFeature Windows-Defender`
- FN: `mdadm --stop|--zero-superblock|--remove|--fail|--create`（disk、`--detail` は非検知）
- FN: `loginctl enable|disable-linger`（scheduled、standard）
- FN: security software の soft-prefix（`env`/`timeout 5`/`stdbuf` 等）

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 33

- FN: `Set-MpPreference -DisableTamperProtection` / `Add-MpPreference -ExclusionProcess` 等
- FN: `systemctl --user enable|mask`（scheduled、standard）、`systemctl --user` 一般操作（service）
- FN: `systemctl stop clamav-daemon|falcon-sensor|mdatp` 等（security software disable、standard）
- FP: 素の `batch` → パイプ経由のみに限定

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 32

- FN: `crontab /tmp/…` / `env crontab -e` / `at -f … now` / `batch` / `anacron -f`（scheduled、**standard でもゲート**）
- FN: `Set-MpPreference -Disable*` / `Add-MpPreference -ExclusionPath` / `sc stop WinDefend`（security software disable、standard）
- `crontab -l` / `Get-MpPreference` は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 31

- FN: `echo … > /etc/…` が docsOnly 扱いで path mutation をすり抜け → リダイレクトを docsOnly 除外
- FN: `nft flush/delete`、`pfctl -d|-F all`、`iptables -F|-X`、`setenforce 0`、`aa-disable|complain|remove`、`apparmor_parser -R`
- list/status / 素の `echo hello` は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 30

- FN: `ufw disable` / `Set-NetFirewallProfile -Enabled False` / `firewall-cmd --panic-on|--set-default-zone=drop` / `iptables -P … DROP`
- FN: `bootctl install` / `systemd-boot install` / `sbsign` / `dracut --regenerate-all`（standard でもゲート）
- FN: `dscl -delete /Users/` / `sysadminctl -deleteUser` / `profiles remove` / `security authorizationdb write|remove` / `userdel|deluser`

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 29

- FN: `Set-SecureBootUEFI` / `Confirm-SecureBootUEFI` / `update-secureboot-policy`、`tpm2_clear`/`Clear-Tpm`/`Initialize-Tpm`（boot）
- FN: `Disable-BitLocker`/`Enable-BitLocker`、`manage-bde -on`/`-protectors add`（disk）
- FP: `npm run … -- --global`（install 文脈なしの --global/-g を非検知）

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 28

- FN: `nvram KEY=value`（boot 代入）、`spctl --global-disable|--disable-assessment`
- FN: `bootctl set-default|set-oneshot`、`grub-set-default`/`grub-reboot`/`update-grub2`/`grub2-mkconfig`/`kernel-install`/`bootsect`/`grub-editenv set`/`dracut --force`
- FN: `fdesetup changerecovery`
- FP: `diskutil verifyVolume|Disk|Container`（読み取り検証）

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 27

- FN: `mokutil --disable-validation`（boot）、`firmwarepasswd -delete`（firmware）、`spctl --master-disable`（policy）
- list/status/check / 散文検索は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 26

- FN: `csrutil disable` / `nvram -c|-d` / `bless --setBoot`（boot）
- FN: `takeown`（acl 変更、icacls と同系）
- status/print / `echo csrutil disable` は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 25

- FN: `networksetup`/`airport`（Wi-Fi off）、`netsh advfirewall … state off`
- FN: `manage-bde -off` / `fdesetup disable`（暗号化解除）
- show/status / `echo networksetup …` は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 24

- FN: `wsl --shutdown|--terminate|--unregister`、`vssadmin delete shadows`、`cipher /w`
- FP: `cp /etc/os-release .`（OS外へのコピーアウト）、`format.com /?` など disk help

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 23

- FN: `podman machine stop|rm`、`rdctl shutdown`、`finch vm stop`、`utmctl`/`prlctl`/`vmrun` stop
- `podman machine start` / `echo podman machine stop` は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 22

- FN: `kind`/`k3d` cluster delete|stop、`docker desktop stop`、`orb stop`
- `kind create` / `echo kind delete` は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 21

- FN: `terragrunt destroy`、`vagrant halt` / `destroy` / `suspend`
- `echo vagrant halt` は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 20

- FN: IaC 破棄 — `terraform`/`tofu`/`pulumi`/`cdk`/`sam` の `destroy`/`delete`
- standard でもゲート（`infrastructure destroy`）。`plan` / `echo terraform destroy` は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 19

- FN: `kubectl drain/delete node`、`doctl`/`hcloud`/`linode-cli`/`vultr-cli`、`multipass`/`limactl`/`colima`/`minikube` stop
- `kubectl get` / `echo multipass stop` は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 18

- FN: クラウド／HV 電源操作 — `aws ec2 stop/reboot` / `az vm` / `gcloud compute instances` / `nova` / `openstack server` / `xl`/`xe` / `Stop-VM`
- `echo aws …` / `Get-Help Stop-VM` は非検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 17

- FN: VM 管理の電源操作 — `virsh` / `qm` / `pct` / `VBoxManage controlvm … poweroff`
- `echo virsh shutdown` はコマンド位置化で非検知のまま

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 16

- FN: `nerdctl` / `lxc` / `machinectl` / `firejail` / `ctr` soft-prefix
- FP: 相対パス `src/lib/...` が cwd∈Users だけで user-data になるのを防止

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 15

- FP: `echo '…; shutdown…'`（documentation-only はルール分類自体をスキップ）
- FN: `erl os:cmd` / `Deno.Command` / `deno <<EOF` heredoc 本文
- 実コマンド `echo foo; shutdown` は引き続き検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 14

- FP: `echo rm -rf /` / `echo iex 'shutdown'`（documentation-only はネスト展開・パス変異ゲートをスキップ）
- FN: `elixir System.cmd` / `bun`/`deno` ラッパ認識

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 13

- FP: `echo Set-ExecutionPolicy` / `msiexec` / `net user` / `curl|bash` など（policy・download をコマンド位置化）
- FN: `tclsh <<< 'exec …'` / `julia -e 'run(\`…\`)'` / `Rscript -e`

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 12

- FP: `echo systemctl/reg/modprobe/bcdedit/fwupdmgr/apt`、`Get-Help New-Service`（各ルールをコマンド位置化）
- FN: `docker exec` / `kubectl exec --` / `ansible -a` / `expect -c 'spawn …'`

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 11

- FP: `echo mkfs` / `echo diskpart` / `Get-Command Format-Volume`（disk 系をコマンド位置化）
- FN: `osascript` / `ssh` / `lua` / `parallel` / `at` heredoc・`echo|at`
- soft-prefix のホスト名・パス引数を復元（`flock /tmp/l`・`ssh localhost`）

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 10

- FP: heredoc 本文の `shutdown`（`maskHeredocBodies`）
- FN: `flock`/`ionice`/`nsenter`/`unshare`/`chroot`/`watch`/`systemd-run` soft-prefix + パス引数
- FN: `script -c` / `fish`/`csh` / `schtasks /tr` / `passthru` / `gnome-session-quit`

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 9

- FP: `command -v shutdown`（soft-prefix の `-v`/`--help` 除外）、`echo format C:`（format をコマンド位置化）
- FP: `shutdown-manager`（`(?![\w-])` 境界）
- FN: `dash`/`ash`/`ksh -c`、`setsid`/`xargs`、`php -r` + `system(`、ネスト深度 2→4

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 8

- PS `-WindowStyle Hidden -Command` / `/Command` / `-e` EncodedCommand、`cmd /r`
- `PATH=/sbin shutdown`、`echo | env bash`、`wsl sudo`、`-Verb 'RunAs'`
- `require('child_process').execSync` / argv tuple `subprocess.run((...))`
- cmd caret `shut^down`、ANSI-C octal `shu\164down`、`ruby -rjson -e`
- soft-prefix に env 代入・`call`/`start`/`wsl` を elevation 側でも揃える

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 7

- `echo | cmd` / `| /bin/bash`、パス付き `/usr/bin/sudo`
- `subprocess.run(['shutdown'])`、`start /b` / `""`、`bash -c $'...'`、`cmd //c`
- `Start-Process -Verb:RunAs` / `saps`、`\\?\...\shutdown.exe`、`busctl`

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 6

- `$env:WINDIR\...\shutdown.exe`、モジュール修飾 `Stop-Computer`
- `rundll32 ExitWindowsEx`、WMI/CIM `.Reboot()`、`gsudo`/`su`
- `python os.system` / `echo | bash`、引用付き `"shutdown"`、`start`/`wsl` 接頭辞
- `bcdedit -set`、`/private/etc`、`rg --iglob`、`dd of=/etc/...`

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 5

- `env`/`busybox`/`timeout` 接頭辞の shutdown
- `bash.exe -c`、`&{Stop-Computer}`、ScriptBlock / ArgumentList
- `rm -rf /./`・`find /etc -delete`・`/etc` 空白終端
- `rg --glob='.env*'`、`Select-String` 位置指定、`([char]46)+'env'`
- `telinit` / `sudoedit` / `%WINDIR%\...\shutdown.exe`

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 4

残抜けを追加修正:

- `systemctl reboot` / `loginctl poweroff` / `init 0`
- `pwsh -NoProfile -Command`・`bash --noprofile -c`・`cmd /k`・未引用 `iex`
- `find / -delete`・`rm -rf /*`
- `Select-String -Path .env` / `rg --glob .env*`
- `\\?\C:\Windows` write、`/dev/null` write 過検知、任意 `dd` 過検知

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate ループ tick 3

残 FP/FN を追加修正:

- `>/dev/null`・`src/lib`・`C:\dev` の system path 過検知（絶対 OS パスのみ）
- `sudo`/`Stop-Computer` の anywhere 過検知 → コマンド位置
- `/sbin/shutdown`・`bash -lc`・`wmic os call reboot`・`iex 'shutdown'`・`format /FS:NTFS C:` の抜け
- `kill -1 <pid>` 自己停止誤検知、`grep .env README` 誤ブロック
- UI: low と standard が同フィルタである旨を説明に反映

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate 残バグ（ループ tick）

526e15b 後の再調査で修正:

- `format C:` 回帰（`:` 後の `\b` が死んでいた）
- grep/find の glob・pattern 経由の `.env*` 読み取り抜け
- `npm install firmware/driver`・`git log --grep=shutdown` 過検知
- `rm -rf /` が system path に当たらない（`[\\s]` 文字クラスバグ）
- `cd node_modules && npm test` 誤ブロック
- `wmic … get` の自己停止誤検知
- standard で `/etc` 等 OS パス write が確認なしだった件

検証: extension 12 テストパス。

---

## 2026-09-05: permission-gate / 安全ガード不整合修正

`/loop 2m` で system safety / permission-gate の実バグを一括修正。

**過検知（default standard）**
- bare `format`（`npm run format` 等）が disk 扱い → `format.com`/`format.exe`/ドライブ引数のみ
- プロジェクト `src/modules` / `src/firmware` が driver/firmware → OS パスに限定
- `install modules` が kernel 扱い → `kernel` / load|unload module のみ

**抜け**
- Pi `read`/`grep`/`find`/`ls` が `.env` 等を読める → 秘密パスは読み取りもブロック（`.git`/`node_modules` は許可）
- `& ('Stop-'+'Computer')` / EncodedCommand が low/standard で落ちる → 保護パスと同じデコード＋UTF-16LE 展開
- `find .git -delete` / bare `git stash` が読み取り扱い → ブロック
- 子 `process.exit()` を自己停止扱い → 除外
- `process.env.NODE_MODULES` が node_modules 保護ヒット → パス境界必須

検証: extension 12 / web safety 14 テストパス。ループ PID 29240 継続中。

---

## 2026-09-05: 本番ビルド型エラー修正

`npm run build` が TypeScript チェックで失敗。

1. **GlobalAttentionProvider.test.tsx** — `kinds: [...] as const` が readonly タプルになり `AttentionItemDto["kinds"]` に非互換。`AttentionItemDto` 明示注釈に変更。
2. **hang-watchdog.test.ts** — `let resumed: T | null = null` が CFA で null に狭まりコールバック代入後も never 扱い。`let resumed = null as ResumeCapture | null` に変更。
3. **harness.ts readOfflineSessionSnapshot** — `state().pi` が null のまま参照。`openSettingsManager` と同様の null ガードを追加。

検証: `npm run build` 成功、関連 vitest 27 件パス。

---

## 2026-09-05: 発見→修正ループ Tick 44

**完全削除が Goal loop を止めない** — `archiveTask` は abort してから dispose するが、`destroyTask` / `destroyProject` は dispose だけ。プロジェクト削除後もタイマーが残る。削除前にも abort する。

## 2026-09-05: 発見→修正ループ Tick 43

**復元しても開いているタブが読み取り専用のまま** — `archiveTask` は SSE を出すが `restoreTask` は status だけ戻す。履歴タブの TaskView は `archived` のまま Composer を閉じたまま。復元時も snapshot を送る。

## 2026-09-05: 発見→修正ループ Tick 42

**アーカイブ履歴タブが他操作で閉じる** — デスクトップの存在確認が archived 除外リストなので、履歴として開いたタブが `tasks-changed` のたびに削除扱いになる。archived を含め、新規アーカイブと完全削除だけ閉じる。

## 2026-09-05: 発見→修正ループ Tick 41

**アーカイブ済みでも Composer が送れる** — サーバーは 409 だが UI は通常の入力面のまま。アーカイブ直後の SSE も idle で止まり `archived` が届かない。snapshot を送り、送信・設定・再開を読み取り専用にする。

## 2026-09-05: 発見→修正ループ Tick 40

**アーカイブを開くと会話が空になる** — Tick 39 は live 再生成を止めたが、履歴も bootstrap の空配列のまま返していた。SSE ready がタイムラインを消す。session ファイルを読み取り専用で射影する。

## 2026-09-05: 発見→修正ループ Tick 39

**実行中タスクのアーカイブがセッションを起こし直す** — `archiveTask` は `disposeLive` だけで abort せず、`ensureLive` も `archived` を見ない。SSE の ready がセッションを再作成し、Goal loop やキューが動き続ける。アーカイブ前に abort し、archived なら live を作らない。

## 2026-09-05: 発見→修正ループ Tick 38

**steer の楽観ユーザー行が停止後も残る** — 割り込み送信は履歴に載る前に SDK キューへ入る。abort / hang abort はサーバーキューを捨てるが、クライアントの pending 行は user 件数増まで残す。タイムラインに存在しない文が残る。停止・hang イベントで pending も捨てる。

## 2026-09-05: 発見→修正ループ Tick 37

**Goal loop ターン間のエージェント切替が古いタイマーを残す** — ループは idle になるので UI が切替を許し、disposeLive は session_shutdown を飛ばす。古い schedule が新セッションと競合する。昇進と同じく queued/running 中は 409。

## 2026-09-05: 発見→修正ループ Tick 36

**Goal loop ON のまま実行中に送るとキューに埋まって動かない** — working + キュー分岐が Goal loop より先に走り、drain は `goalLoopEnabled` で永久停止する。Goal loop 中はキューせず、送信も拒否する。

## 2026-09-05: 発見→修正ループ Tick 35

**送信受理後も停止ボタンが出ない** — queuePrompt は promptActive にするが status は agent_start / 圧縮後まで idle。HTTP も idle のまま返すので、圧縮待ちのあいだ停止できず設定 UI も開いたまま。受理時点で working にし、クライアントも応答の task を反映する。

## 2026-09-05: 発見→修正ループ Tick 34

**停止後に compaction 待ちのプロンプトが再起動する** — abort は SDK を止めるが harness の promptChain は残る。圧縮/ルート準備の await のあと session.prompt が走る。世代番号を abort で上げ、待ち解除後は破棄する。

## 2026-09-05: 発見→修正ループ Tick 33

**実行中に権限モード/スキル権限を差し替えられる** — UI は閉じているが API に busy ガードが無く、同一ターンの後続 tool から gate が新モードを読む。スキル変更は `session.reload()` も走る。モデル/思考レベルと同じく busy なら 409。

## 2026-09-05: 発見→修正ループ Tick 32

**応答中の思考レベル変更が同一ターンの次 LLM 呼び出しに効く** — ThinkingSelect は compacting 以外開いたままで、`setTaskThinkingLevel` に busy ガードが無かった。ツール後の継続応答から effort が変わる。モデル切替と同じく busy なら 409 にし、セレクトも閉じる。

## 2026-09-05: 発見→修正ループ Tick 31

**同一アカウントのモデル切替が進行中ターンを差し替える** — Tick 29 はアカウント切替だけ busy 拒否だった。同じアカウント内の `setModel` は promptActive / ストリーム中でも通り、送信直後は UI もまだ開いていた。busy なら 409 にし、送信中もセレクトを閉じる。

## 2026-09-04: 発見→修正ループ Tick 30

**ハング abort の idle 窓で follow-up が自動送信される** — watchdog は abort 後に idle を待ってから再送する。クライアントは `hang_retry` までキューを残し、その間の idle で drain していた。abort の前に `hang_abort` を送り、キューを先に捨てる。

## 2026-09-04: 発見→修正ループ Tick 29

**送信直後のアカウント切替が進行中プロンプトを壊す** — `setTaskModel` は `isStreaming` だけ見て `disposeLive` していた。`promptActive` や圧縮中はストリーム前でもセッションを捨て、応答が欠ける。エージェント切替と同じく busy なら 409 にし、モデル選択も working 中は閉じる。

## 2026-09-04: 発見→修正ループ Tick 28

**「後で」のベルが送信ボタンを塞ぐ** — タスク画面の Composer 送信は右下、注意ベルも `fixed right-4 bottom-4 z-[80]` だった。他タスクの承認を後回しにすると送信をタップできない。タスク画面ではベルをフッタ上へ上げ、ホームは従来位置のままにする。

## 2026-09-04: 発見→修正ループ Tick 27

**注意ポーリングが二重起動する** — マウント時に即時 `poll()` と `setTimeout(loop)` を両方走らせていた。初回 GET が 4 秒を超えると in-flight のまま次の poll が始まり、注意音と自動オープンが二重化する。`loop()` だけにして完了後に次を予約する。

## 2026-09-04: 発見→修正ループ Tick 26

**承認直後に空のカードが残る** — 許可/質問に応答しても `items` は次の 4 秒ポーリングまで古いまま。details だけ null になるので、タイトルと「開く」だけのゴーストが出る。描画時に明示的に解消済みの要求を一覧から外し、遅れている GET が同じ request id を戻しても上書きしない。

## 2026-09-04: 発見→修正ループ Tick 25

**「後で」すると承認モーダルを戻せない** — 閉じると `open=false` のまま描画せず、再表示手段が無かった。別タスクの未処理が残っているときは件数付きのベルを出し、そこからモーダルを開き直せるようにする。表示中タスクのみの要求はインライン UI に任せる。

## 2026-09-04: 発見→修正ループ Tick 24

**タスク切替直後に承認カードが消える** — SSE の bootstrap は履歴を空で先に送るが、pending の permission/question と abort/hang 状態を載せていなかった。ensureLive 待ちの間、切替先タスクの承認 UI が見えない。in-memory pending とタスク記録の再開目印を bootstrap に載せる。

## 2026-09-04: 発見→修正ループ Tick 23

**同じタスクの 2 回目の承認で音もモーダルも出ない** — `seenIds` が解消後も `taskId:permission` を残していた。次の許可要求は fresh にならず、音も自動オープンも起きない。現在の attention に無いキーは捨てる。

## 2026-09-04: 発見→修正ループ Tick 22

**Goal loop 中に画像を貼れる** — 添付ボタンは無効だが、ペーストは `addImageFiles` を呼んでいた。開始時に「Goal loop では画像は使えません」で落ちる。ボタンと同じ条件で貼り付けも拒否する。

## 2026-09-04: 発見→修正ループ Tick 21

**ハング再試行回数がセッション差し替えで消える** — `hangRetryCount` は live メモリだけだった。アカウント切替やプロセス再起動の `attachSession` が常に 0 に戻し、SSE ready の通知も落ちる。abort/revert と同じくタスク記録へ保存し、通常の新規プロンプトで 0 に戻す。

## 2026-09-04: 発見→修正ループ Tick 20

**別タスクの承認モーダルが自動で開かない** — `tryAutoOpen` が `setItems` 後の effect を待たず空の `itemsRef` を見ていた。入力中でなくてもモーダルは focusout まで出ず、音だけ鳴って承認 UI が見えない。ポーリング結果を ref へ先に書いてから開く。

## 2026-09-04: 発見→修正ループ Tick 19

**ホームから画像のみでタスクを開始できない** — 既存タスクの Composer と prompt API は本文なし画像を許可するが、ホームの送信ボタンと `POST /api/tasks` は空テキストで拒否していた。画像を付けても開始できず、Ctrl+Enter も無視される。添付があれば本文なしでも作成できるようにする。

## 2026-09-04: 発見→修正ループ Tick 18

**画像のみの送信がハング監視に乗らない** — Tick 17 で手動再開は直したが、`armTaskHangWatch` が空テキストで即 return し、continue 再開も常に画像を捨てていた。ハング後に「続けて」だけが飛び、画像の文脈が消える。添付があれば監視対象にし、画像のみなら continue でも画像を付けて再送する。

## 2026-09-04: 発見→修正ループ Tick 17

**画像のみのプロンプトが再開できない** — Composer と prompt API は本文なし画像を許可するが、`findResumableTurn` が空テキストで即 null にしていた。中断/無言終了後に再開ボタンも自動再開も出ない。添付があれば再開対象にし、continue モードでも画像のみなら画像を付けたまま再送する。

## 2026-09-04: 発見→修正ループ Tick 16

**停止後も許可/質問カードが残る** — abort は SDK キューを捨てるが、permission/question の in-memory pending は残していた。停止後も承認 UI と GlobalAttention がゴーストになり、次の許可要求が古い要求の後ろに積まれる。タスク単位で pending を deny/null して resolved を送る。

## 2026-09-04: 発見→修正ループ Tick 15

**SSE 再接続で EventSource が多重化する** — ネットワーク error 時に旧 retryTimer を clear せず、connect も既存接続を閉じなかった。連続切断で同じタスクにストリームが複数立ち、タイムラインや許可カードが二重更新される。再接続前にタイマーと既存 EventSource を必ず破棄する。

## 2026-09-04: 発見→修正ループ Tick 14

**ハング abort が steer/follow-up キューを残す** — 手動停止は `clearQueue` するが、watchdog の abort は `session.abort()` だけだった。ハング再送と同時に古い割り込みが走ることがある。ハング abort でもキューを捨て、クライアントは `hang_retry` で queuedFollowUps を空にする。

## 2026-09-04: 発見→修正ループ Tick 13

**応答前停止の再開目印がリロードで消える** — Tick 9 で ready に載せたが、`manualAbortedAssistantId=""` は live メモリだけだった。エージェント切替やプロセス再起動で再開ボタンが消える。`revertLeafId` と同じくタスク記録へ保存し、attachSession で復元する。

## 2026-09-04: 発見→修正ループ Tick 12

**巻き戻しの復元がリロード後に消える** — `isReverted` はクライアント専用、`revertLeafId` も live メモリだけだった。リロードやエージェント切替で復元 UI が消え、unrevert は 404 になった。leaf をタスク記録へ保存し、SSE ready からバナーを復元する。unrevert は `ensureLive` を使う。

## 2026-09-04: 発見→修正ループ Tick 11

**steer がストリーム開始前に並列 prompt になる** — `promptActive` だけで promptChain を迂回していた。新規タスク作成直後など UI は working だが未ストリームの窓で割り込み送信すると、先発が `Agent is already processing` で落ちる。迂回は `isStreaming` のときだけ。未ストリームなら通常の次ターンとして chain する。

## 2026-09-04: 発見→修正ループ Tick 10

**停止後にキュー待ち follow-up が自動送信される** — サーバーは abort 時に `clearQueue` するが、TaskView の `queuedFollowUps` は残ったまま working→idle で drain→submit していた。停止時にキューを捨て、drain/auto-send は `stopRequested` 中は動かない。

## 2026-09-04: 発見→修正ループ Tick 9

**SSE ready に中断 ID が無く「再開」が消える** — 応答前に停止すると harness は `manualAbortedAssistantId=""` を置くが、ready も `getTaskDetail` も載せていなかった。再接続でクライアントが null にリセットされ、再開ボタンが消える。`hangRetryCount` も同様に ready へ載せる。

## 2026-09-04: 発見→修正ループ Tick 8

**SSE ready 待ち中に承認イベントが後続スナップショットで消える** — 非 delta が来るたびに pending を全クリアしていた。`permission_request` の直後の履歴 snapshot で許可カードが消え、応答後の `permission_resolved` も落ちてカードが固まる。制御イベントは coalesce 時に残す。

## 2026-09-04: 発見→修正ループ Tick 7

**SSE ready 後に承認/ハング再試行イベントが捨てられる** — `shouldFlushPendingAfterReady` がメッセージ履歴の新しさだけで判断していた。fetch 中に届いた `permission_request` / `hang_retry` などは ready と同じ履歴だと破棄され、カードや再試行表示が消えた。制御イベントは履歴が同じでも flush する。

## 2026-09-04: 発見→修正ループ Tick 6

**スキル権限が毎プロンプトで潰される** — permissionMode と同じ。TaskView が共有 localStorage を既存タスクへ再送し、live セッションのスキル許可を上書きしていた。変更は `/skill-permission` のみ。タスク切替時はキャッシュから復元する。

## 2026-09-04: 発見→修正ループ Tick 5

**セッション再接続で権限モードが落ちる** — `ensureLive` / アカウント切替が `task.permissionMode` を渡していなかった。sessionId が変わると `sessions[oldId]` が当たらず既定 allow に戻る。再接続時にタスク保存値を新しい sessionId へ書き戻す。

## 2026-09-04: 発見→修正ループ Tick 4

**GlobalAttention の二重承認 UI** — 表示中タスクと別タスクが同時に attention になると、モーダルが TaskView と同じ許可/質問カードを描画していた。表示中タスクはバッジと「開く」のみにし、操作 UI はインライン側に任せる。

## 2026-09-04: 発見→修正ループ Tick 3

1. **権限モードが毎プロンプトで潰される** — TaskView が共有 localStorage を既存タスクへ再送していた。モード変更は `/permission-mode` のみ。タスクレコードに `permissionMode` を保存し、プロンプト経路では再適用しない。
2. **commit-guard の遅い session_start** — git status 完了前の `agent_settled` をキューし、遅延初期化でゲート状態をリセットしない。

## 2026-09-04: 発見→修正ループ Tick 2

権限モードが `permission-gate.json` の単一 `mode` で全タスク共有だった。`sessions[sessionId]` を優先し、デフォルト `mode` は新規セッション専用にした。`session_start` が全体デフォルトで上書きしない。回帰: `permission-gate-config.test.ts` / `index.test.ts`。

## 2026-09-04: 発見→修正ループ Tick 1

ループ: 2分間隔、センチネル `AGENT_LOOP_TICK_findfix`、ユーザー停止指示まで継続。

1. **保護パス難読化バイパス** — `chr(46)+'env'` / `[char]46` / `'.'+'env'` / `\x2e` をデコードして再検査。`index.test.ts` に回帰を追加。
2. **README** — 権限の簡易承認 UI は実装済みなので「未実装」から外した。
3. **goal-loop テスト** — `package.json` に `test` を追加し、ルート `npm test` に含めた。
4. **leafcode-question の typebox 未宣言** — `package.json` に dependency を追加（peer ツリーを引く lockfile は作らない）。

次 tick 候補: 権限モードがプロセス全体の単一ファイル（並行タスク干渉）、`writeConfig` 失敗の握りつぶし、未使用 SESSION_KEY、ルート typecheck の拡張カバレッジ。

## 2026-09-04: バグハント残件6件を修正

1. **Sidebar refresh stale** — `refreshGenRef` で古い poll 応答を破棄
2. **保護パス シェルバイパス** — `.env*` とシェル内の保護パス参照を block
3. **memory markdown lock** — heartbeat renew + fencing、`staleMs` 45s
4. **commit-guard** — `2>&1` 偽陽性排除、npm/pip/cargo 検出、dirty fingerprint 変化を主信号
5. **translation ready** — Python が ready 行を送信するまで `starting`、stdin backpressure 修正
6. **host lock EPERM** — ESRCH のみ死亡、EPERM は生存扱い


## 2026-09-04: git branches/push の production typecheck 失敗を修正

`gitDirectoryError` 導入後、`branches` が検証後も `directory`（`string | null`）を `runGit` に渡し、`push` は `body` が null のまま参照していた。`dir` / 分割代入で絞り込んで typecheck を通す。


## 2026-09-03: バグハント継続（SSE / hang-watch / ensureLive / Git path / QuestionCard）

前回バックログの先頭5件を修正。

1. **SSE ready 後の古い pending 上書き** — `shouldFlushPendingAfterReady` で ready より古い snapshot/delta を捨てる。  
   検証: `sse-ready-buffer.test.ts` / `events/route.test.ts`

2. **steer 時 hang-watch prompt 上書き** — `queuePrompt` は `streamingBehavior` 付きでは `armTaskHangWatch` しない。

3. **ensureLive / disposeLive 競合** — `ensureLiveEpoch` で dispose 中の inflight 結果を破棄して再試行。

4. **Git/Diff 任意絶対パス** — `gitDirectoryError` + browse allowlist。未許可は 403。  
   検証: `git-directory.test.ts`（関連ルートテストも更新）

5. **QuestionCard generation ガード** — reply/reject 完了時に generation 照合。TaskView の clear も answeredId 照合。  
   検証: `QuestionCard.test.tsx`

残: Sidebar refresh stale、保護パスのシェルバイパス、memory lock renew、commit-guard、translation ready、host lock EPERM。


## 2026-09-03: 徹底バグハント（証拠付き Critical/High 修正）

観点: 状態/UI・並行/race・境界値・エラー処理・拡張コンテキスト揮発・プロセス制御。サブエージェント3系統 + コード再検証。

### 修正済み（回帰テストあり）

1. **Critical — permission-gate deny/ask が無効**  
   `ExtensionContext` は Pi の `createContext()` でイベントごとに新規生成されるため、ctx 直書きのモードが `tool_call` に伝わらず常に allow。モードを `permission-gate.json` 再読込に変更。`applyPermissionMode` の使い捨て ctx 書き込みを削除。  
   検証: `extensions/leafcode-permission-gate/index.test.ts`（別 ctx インスタンス）+ `permission-gate-config.test.ts`

2. **Critical — 停止後も steer/follow-up が走る**  
   `abortTask` が `session.abort()` のみで `clearQueue()` せず、SDK の post-run がキューを継続実行。abort 前に `clearQueue` を呼ぶ。  
   検証: `harness-agent.test.ts`

3. **High — GlobalAttention と TaskView の許可UI二重化**  
   アクティブタスクでも `tryAutoOpen()` していた。`onlyActive` 時は音もモーダルも抑止。  
   検証: `GlobalAttentionProvider.test.tsx`

4. **High — 許可応答成功で別 request を潰す**  
   `setPermissionRequest(null)` を answeredId 照合に変更（TaskView）。

5. **High — subagent failed を paused 誤分類**  
   `success:false` + `exitCode===0` を paused にしていた。明示 `state` を優先。  
   `stale-run-reconciler.ts` / `run-status.ts`

6. **Medium — process-stop が常に "hard"**  
   `isAlive ? "hard" : "hard"` → 生存時 `"alive"`。  
   検証: `host/src/process-stop.test.js`

7. **Medium — stabilize fingerprint 欠落**  
   tool `input`/`subagentRunIds`/`title` と message の `accountId`/`model`/`provider` 等を fingerprint に追加。

### 未修正（記録のみ・優先度順）

- SSE ready 後の古い pending バッファ上書き（`events/route.ts`）
- steer 時 hang-watch の prompt 上書き（`harness.ts` queuePrompt）
- ensureLive inflight と disposeLive 競合
- Git/Diff API の絶対パス許容（browse allowlist 未適用）
- QuestionCard の generation ガード死コード
- Sidebar refresh の stale 上書き
- 保護パスのシェル/`.env*` バイパス（permission-gate）
- Memory markdown lock の renew/fencing なし
- commit-guard 偽陰性（npm等）/ `2>&1` 偽陽性
- translation-service ready レース
- host lock の EPERM=死亡扱い


# LeafCodePi メモリ

## 2026-09-03: 画面分割でComposerが欠ける不具合

分割レイアウトをツリー描画へ移行した際、`PaneLayoutBranch` の子ラッパーが `flex-col` になっておらず、ペイン高さが TaskView へ伝播しなかった。`overflow-hidden` により Composer 下端が切れて見えなくなる。子ラッパーへ `flex flex-col overflow-hidden` を付与し、TaskView を Home と同様の `flex-1` ラッパーで包んだ。回帰テストを `TaskPanesHost.test.tsx` に追加。

検証: `TaskPanesHost.test.tsx` 4 tests、`task-panes.test.ts` 71 tests 成功。

## 2026-08-30: Auto候補ルートとusage-aware選択

Autoのv2候補ルート、モード別設定UI/API、localStorage/server同期、モデル表示・Goal Loop/follow-up接続を実装。CodexBarのモデル利用率をAuto選択へ渡し、limited除外・20ポイント差の低利用率provider迂回・アカウント別usageキーを追加。Web typecheck、lint、production build、全151 files / 882 tests、関連28 testsが成功。ユーザーの明示的commit指示がないため未コミット。

## 2026-08-30: OneDrive build mirror の同一サイズ・時刻 stale

`scripts/web-build-mirror.mjs` がサイズと mtime だけで repository-owned file を unchanged 扱いし、OneDrive が時刻を維持した同一サイズ変更で古い `TaskView.tsx` をビルドへ渡していた。bytes を比較してから再コピーするよう修正し、回帰テストを追加。コミット: `fd2854c`。

検証: host 全115 tests、Web auto-model 11 tests、typecheck、production build 成功。

## 2026-08-29: 直接生成で選択アカウントが失われる不具合

`NextAction` / `NextTaskSuggest` がモデル値の文字列を `split("::")` していたため、マルチアカウント選択時に provider/model の解釈が崩れ、選択アカウントも直接生成へ渡らなかった。`selectedModel` オブジェクトをそのまま渡し、`parseDirectModel` が `accountId` を保持するよう修正。回帰テストを追加。コミット: `354524f`。

検証: Web 全144 files / 841 tests、typecheck、lint、diff --check 成功。

## 2026-08-27: llama.cpp プロバイダーの重複表示

`llama-provider.ts` が Pi SDK の組み込み `llama.cpp` プロバイダーと、LeafCodePi 独自の `llama-server` プロバイダーを同時登録していたため、設定画面に同系統の行が2つ表示されていた。組み込みプロバイダー登録と不要なアイコン別名を削除し、`llama-server` の起動・モデル同期は維持した。コミット: `0e3eb31`。

検証: llama-provider / provider-icons / codexbar の関連テスト 58 tests、typecheck、lint 成功。

## 2026-08-27: Tailscale bind のリンクローカル誤選択

`findTailscaleIPv4` が Tailscale 名のNICでは IPv4 の範囲を検証せず、瞬間的な `169.254.x.x` を選択して `/api/health` の起動プローブが到達不能になった。CGNAT 100.64/10 だけを採用し、回帰テストを追加。コミット: `4afcc21`。

## 2026-08-28: production build 中の Tailscale bind 消失

`next build` 中に Tailscale の IPv4 が消えると、起動時に取得したアドレスをそのまま使い続けて `EADDRNOTAVAIL` になっていた。保存済みアドレスへのフォールバックを廃止し、Next.js 起動直前に bind を再取得して未検出時は `127.0.0.1` に戻す。回帰テスト、全テスト、typecheck、lint 成功。未コミット。

## 2026-08-27: CodexBar account scope の認証境界を補強

Command Code / Cursor / Ollama Cloud / OpenCode Go の provider factory が `authPath` の有無だけで account scope を判定していたため、壊れた `UsageScope`（account + authPathなし）では既定環境変数・ローカル認証・共有cookieへ流れる余地があった。account scope は `scope.kind` を正として、認証パス・account IDが無い場合は未設定扱いに固定し、回帰テストを追加。Web 139 files / 830 tests、typecheck、production build、lint（既存warning 8件のみ）成功。ユーザーの明示的commit指示がないため未コミット。

## 2026-08-27: アカウントruntimeのambient認証漏れ

`ModelRuntime` はアカウントの `auth.json` に保存済みcredentialが無い場合、環境変数のAPIキーでモデル・認証を報告できる。`harness.ts` のアカウントモデル/catalog/auth一覧は保存済みかつアカウントに宣言されたproviderだけを採用し、既定runtimeのaccount-only providerは常に除外する。回帰テストを追加し、Web全139 files / 828 tests、typecheck、production build、lint（既存warning 8件のみ）を確認。未コミット。

## 2026-08-27: APIキー系アカウントの既定認証UI

`isAccountProviderId` を Ollama Cloud / OpenRouter まで広げた際、ProviderAuthPanel がその判定を「既定認証を隠す」条件にも使い、APIキー系の環境変数・既定APIキー入力・ログアウト操作を隠していた。既定認証を隠す対象は `openai-codex` / `anthropic` のみとし、アカウント対応可能なAPIキー系は既定UIと追加アカウントUIを併存させた。コミット: `9fd21ae`。

検証: ProviderAuthPanel 10 tests、Web 全138 files / 811 tests、typecheck、lint（既存warning 8件のみ）。対象sessionの `fetch failed` は別件で、Codex WebSocket が `before_message_stream_start` に失敗後 SSE fallback も失敗したネットワーク/transport事象（request 142112 bytes、トークン消費0）。

## 2026-08-27: マルチアカウント対応プロバイダーの既定経路

`ACCOUNT_ONLY_PROVIDER_IDS` を `ACCOUNT_PROVIDER_IDS` 全体へ拡張し、Anthropic/Codex と同様に Ollama Cloud、OpenRouter、Command Code、Cursor、OpenCode、OpenCode Go の既定認証・モデル候補・既定認証UIを廃止した。アカウントランタイムとアカウント別設定は維持する。コミット: `59aa8e3`。

検証: ProviderAuthPanel / harness runtime 24 tests、Web 全139 files / 826 tests、typecheck、production build、lint（既存warning 8件のみ）。

## 2026-08-27: マルチアカウント起動時のモデル初期化集中

`/api/health` の1.5秒プローブが重なる間、optional provider 初期化と全アカウントモデル列挙が単一化されず、Command Code カタログを同じ一時パスへ同時取得して timeout / rename 競合を起こしていた。Command Code の拡張ロードをプロセス共有し、optional provider と全アカウントモデル列挙を single-flight 化。health は全 account runtime を作らず認証ファイルと直近モデルsnapshotでreadinessを返し、アカウント一覧は対象providerだけを照会する。

検証: 回帰テストは修正前に catalog fetch 3回・account availability 2回を再現し、修正後は各1回。Web全135 files / 789 tests、関連59 tests、3回連続回帰テスト、typecheck、lint（既存warning 8件のみ）が成功。

## 2026-08-27: production startup の実機確認

既存 host と WebUI は稼働中で、`100.98.131.68:3010/` は `/login` へ 307、`/api/health` は 200（`ok: true`）。既定 bind は Tailscale の `100.98.131.68` なので `127.0.0.1:3010` では接続できない。別ポート・別データディレクトリの headless production 起動でも、初回ミラー同期＋ビルド後に WebUI と `/api/health` が成功した。初回は約92秒、Command Code のモデル取得 timeout はキャッシュへフォールバックする非致命ログ。

## 2026-08-27: オフライン環境の production build 失敗

`web/src/app/layout.tsx` の `next/font/google`（Geist / Geist Mono）がビルド時に Google Fonts を取得するため、ネットワーク制限下で `@vercel/turbopack-next/internal/font/google/font` の解決失敗と `Failed to fetch Geist from Google Fonts` が発生した。Google font import を除去し、`globals.css` の system font stack に切り替えた。コミット: `6e89824`。

検証: 修正前 `npm run build` は失敗、修正後 production build / typecheck / lint、Web 135 files・787 tests が成功（lint は既存 warning 8件のみ）。

## 2026-08-26: 左メニューのGoal Loop進捗表示

Sidebar のタスク進捗バーは、`queued` / `running` / `verifying_completed` の Goal Loop がある場合に ToDo 進捗を上書きする。API の TaskSummary には `goalLoopSummary`（status/maxTurns/turnCount）だけを付与し、冷起動タスクも `.pi/goals-loop/<sessionId>.json` から取得する。コミット: `a41839b`。

検証: Web 全テスト 121 files / 713 tests、typecheck、lint（既存 warning 8件のみ）。

## 2026-08-26: Goal Loop進捗のサイドバー更新通知

`TaskView.notifySidebarIfNeeded` の変更キーが id/status/title だけで、Goal Loop の turnCount/status 更新時に Sidebar refresh event が発火しなかった。`taskSidebarNotifyKey` に Goal Loop の3項目を含め、回帰テストを追加。コミット: `4f57ed4`。

検証: Web 全テスト 124 files / 724 tests、typecheck、lint（既存 warning 8件のみ）。

## 2026-08-26: Goal Loop の送信待ち停止

`agent_end` で結果を `queued` / `verifying_completed` へ遷移した後、次ターンのスケジュールを `agent_settled` だけに依存していたため、通知が遅延すると送信待ちのまま止まった。`agent_end` 自身でも scheduler を起動し、既存の idle・保留メッセージ・クールタイム判定をそのまま通す。回帰テストは `agent_settled` を発火しないケースで次ターン送信を確認。コミット: `f2ad94b`。

検証: Goal Loop 拡張 17 tests、`npm run typecheck`、`npm test`（Web 114 files / 689 tests、host 110 tests）。

## 2026-08-25: 翻訳表示時のタイムライン揺れ

ストリーミング中の仮メッセージID（`msg-N`）が保存後のエントリIDへ変わり、`TaskView` の React key に使われていたため行全体が再マウントされ、実行中に開いたコマンドカードが一瞬閉じてレイアウトが揺れていた。`messageRenderKey` は最初のパートIDを使い、論理ID変更後も行を維持する。コミット: `b5ae154`。

検証: Web 全テスト 114 files / 686 tests、関連テスト、lint。typecheck は別作業中の `src/app/api/accounts/route.test.ts` の既存型エラーで未完了。

## 2026-08-25: 設定モデルタブの表示順と名称

モデルタブを「モデル」「プロバイダ」「生成モデル」の順に変更し、各見出しを短縮。回帰テストを追加。コミット: `1982607`。

## 2026-08-24: leafcode-拡張のWebUI依存

拡張名が `leafcode-` プレフィックスで始まる拡張は、WebUI必須として無効化不可・runtimeフィルタでも保持する。`web/src/lib/extensions.ts` の `isWebUiRequiredExtension` が判定する。

検証: `npm --prefix web test -- src/lib/extensions.test.ts`（26 tests）、`npm --prefix web run typecheck`。コミット: `3e9d26d`。

## 2026-08-24: サイドバーの新規タスクでプロジェクト選択が反映されない不具合

デスクトップの TaskPanesHost はページ側 HomeView を隠しているため、プロジェクトIDクエリを PaneHomeView に渡さず、同一 pathname 上のクエリ遷移では Home タブにも切り替わらなかった。TaskPanesHost で `useSearchParams` を監視して Home タブへ retarget し、HomeView の選択プロジェクトを更新する。useSearchParams のため AppShell に Suspense 境界を追加。

検証: Web typecheck、lint、`src/lib/task-panes.test.ts` 61 tests、host 108 tests。Web 全体テストは既存の React 19.1.0 と Testing Library の `React.act` 非互換で 43 failures。コミット: `4c14947`。

## 2026-08-24: TaskPanesProvider の幅変更時復元競合

モバイル幅で初期化した後にデスクトップ幅へ変更すると、localStorage の保存済みペインが初期 Home 状態に戻る不具合を修正。復元 effect を `mdUp` 変更でも実行し、復元中の初期 URL 同期による上書きを `externalUrlRef` で抑止した。回帰テストを追加。

検証: Web 89 files / 558 tests、host 108 tests、typecheck、lint。コミット: `2840ac6`。

## 2026-08-24: ビルド欠落ファイルの復元

既存変更が参照していた直接生成・次タスク/次アクション・タイトル API と UI が作業ツリーから欠落し、typecheck/build が失敗していた。関連ソースと回帰テストを復元し、typecheck・lint・全テスト・production build を確認。コミット: `7676583`。

## 2026-08-24: ToDo進捗表示の順序

`TodoProgressPanel` のヘッダーで、パーセント表示を `ToDo N/N` の左へ移動。Web typecheck / lint 成功。

## 2026-08-24: Goal Loop 結果JSON欠落で即停止する不具合

モデルが JSON を付けずにターンを終える（例: todowrite 更新だけ）と `unreadable_result` で即一時停止していた。`applyMissingResult` を追加し、1 回目は最終 assistant テキストを progress 記録して継続、次ターンのプロンプトに JSON 必須の警告を注入。`unreadableStreak` 2 連続で従来どおり停止、正常結果でリセット。

検証: 拡張 14 tests、Web 513 tests、typecheck、lint。

## 2026-08-24: Goal Loop 最大ターン後の完了操作

最大ターン数で一時停止した Goal Loop に「完了」ボタンを追加し、`goal-complete` で `completed` へ遷移するようにした。完了後は既存の Composer から新しいループを開始できる。

検証: Web 513 tests + host 108 tests、Goal Loop 拡張 12 tests、typecheck、lint、別ミラーで production build が成功。通常の `npm run build` は稼働中の production WebUI による安全ガードで実行不可だった。

## 2026-08-23: 協調設定を設定画面の一般タブへ露出

`collaboration.json`（モード、ハートビート、リース TTL、stuck、ask タイムアウト、活動上限、check コマンド）はファイル直編集だけだった。設定 UI の「一般」に協調パネルを追加した。

- `GET`/`PUT` `/api/collaboration/config` が同じバリデーションで読み書きする
- 不正値は保存せず fail-closed（実行時は従来どおり既定の strict）
- 変更は新しいセッションまたはホスト再起動から適用される旨を表示する
- 拡張の無効化スイッチとは別。協調拡張自体は必須のまま

検証: `collaboration-config` と `CollaborationSettings` のテスト。localhost:3011 の一般タブで緩和へ切替→保存し、一時 `LEAFCODE_PI_DATA_DIR` の `collaboration.json` が `mode: "permissive"` になった。

## 2026-08-23: leafcode_edit の CRLF 不一致と SSE heartbeat の closed enqueue

リース確保後の `leafcode_edit` が `oldText must match exactly once.` で連続失敗し、WebUI は `Controller is already closed` を繰り返していた。どちらも実害のある欠陥だった。

### 不具合1: CRLF ファイルに LF の oldText が一致しない

Windows の `SettingsView.tsx` は CRLF（160 行すべて `\r\n`）。エージェントは読取結果どおり LF の複数行 `oldText` を送る。`mutate` は `String.indexOf` の生一致だけだったため、改行を含む置換は必ず失敗する。単一行（改行なし）の最初の編集だけ成功していた。

修正: `applyUniqueTextEdit` で改行を正規化して一意一致を取り、書き戻し時はファイルの多数派 EOL を維持する。

### 不具合2: SSE ping が close 後に enqueue する

タスク/プロバイダログインの SSE が `setInterval` で `controller.enqueue` していた。abort で `close()` したあと、すでにキューに入った timer が `ERR_INVALID_STATE` を投げ、`uncaughtException` になる。`send()` 側だけ try/catch があり ping は無防備だった。

修正: `createSseWriter` で closed フラグ・heartbeat 停止・enqueue 失敗時 cleanup を共通化。両 events ルートがこれを使う。

### 検証

```
npm --prefix web test -- --run src/lib/sse-writer.test.ts src/lib/collaboration-room.test.ts ../extensions/leafcode-collaboration/index.test.ts
```

27 tests passed（sse-writer 3、collaboration-room 21、index 3）。新規: LF oldText × CRLF ファイル、heartbeat after close。

拡張と WebUI の反映には LeafCode セッション再起動が必要。本番は `%LOCALAPPDATA%\leafcode-pi\build\...` のミラーから動く。

## 2026-08-23: leafcode-collaboration 徹底バグハント

reserve 直後 edit 失敗の続き。コード・IPC・再接続・Windows パス・lock を洗い、実害のある残件を直した。

### 今回潰した欠陥

1. **pipe 再接続で旧 socket の close が session を offline にし lease を orphan する**  
   同じ `connectionId` の再 join 後に古い close が `markDisconnected` していた。  
   現行 socket だけ切断扱いし、切断を `operationTail` に載せる。同じ connectionId で join したら orphan を復元する。
2. **再接続が `leave` を送り clean lease を released にする**  
   `connectRuntime` は `disconnect()`（leave なし）を使う。
3. **最後の leave の `setTimeout(close)` が直後の join を殺す**  
   遅延 close は世代番号と「誰か online か」を再確認する。
4. **runtime key が cwd 文字列**  
   trailing slash / サブディレクトリで RoomClient が分裂する。key は sessionId + git `projectKey`。
5. **空・壊れた lock を stale と見なさない**  
   ファイルはあるが parse できない lock を takeover 可能にした。
6. **生きた coordinator の listen 前に即 degraded**  
   IPC 失敗時は短く再試行する。
7. **check/commit の pipe RPC が 5s で切れる**  
   check/commit は `CHECK_TIMEOUT_MS + 10s`。
8. **Git パス大小文字で observed が汚染される**  
   `normalizeGitPath` / `updateLeaseObservation` を `relativeKey` に統一。index 指紋は status の後に取る。
9. **`requireRoom` が degraded 理由を捨てる**  
   `connectError` / `degradedReason` を例外に含める。

### 検証

```
npm --prefix web test -- --run src/lib/collaboration-room.test.ts src/lib/collaboration-config.test.ts src/lib/collaboration-room-status.test.ts ../extensions/leafcode-collaboration/index.test.ts
```

27 tests passed。新規: trailing-slash/subdir cwd、空 lock takeover、同一 connectionId の pipe 再接続。

### 残る制約（仕様または環境）

- dirty/orphaned lease の他セッション takeover は仕様どおり未実装。死んだ agent の dirty path は同じ session の再 reserve が必要
- PID 再利用で lock が生きて見える場合は、再試行後も degraded になり得る
- Windows で git スキャンが稀に `git_state` になるのは並列テスト負荷のフレーク。単体再実行では成功する
- hardlink (`nlink > 1`) は予約・編集できない

## 2026-08-23: leafcode-collaboration が reserve 直後に edit できない

報告: `leafcode_collab reserve` は成功するが、続けて `leafcode_edit` が
`An active lease covering this path is required.` で落ち、作業不能。

### 原因

同じ症状を出す独立した欠陥が2つあった。

1. **ツールごとに RoomClient が分裂する**  
   runtime を `WeakMap<ExtensionContext>`、その後 `WeakMap<sessionManager>` で
   持っていた。Pi は tool call ごとに新しい context / sessionManager を渡し得る。
   そのたびに新しい `connectionId` で join し、既存リースが `orphaned` になる。
   再現テスト: `keeps one room client when tool calls use fresh ExtensionContext objects`
   （sessionManager キーでも、start / reserve / edit / shutdown を別オブジェクトにすると落ちる）。

2. **接続中でも clean lease が 15 秒で切れる**  
   既定 `leaseTtlMs` は 15s。coordinator の timer / heartbeat / status は
   `expireCleanLeases()` するだけで、接続中セッションのリースを更新しない。
   エージェントが reserve 後に 15 秒以上考えると、edit 前に `released` になる。

パスの大文字小文字（`SettingsView.tsx` vs `settingsview.tsx`）は Windows では
`relativeKey` で既に正規化済み。今回の失敗の直接原因ではない。

### 修正

- `extensions/leafcode-collaboration/index.ts`: sessionId + cwd 文字列で runtime を共有
- `extensions/leafcode-collaboration/room.ts`: 接続中セッションの lease を heartbeat / status / timer で更新
- 失敗時は orphaned / 他セッション予約をメッセージで区別する

### 検証

```
npm --prefix web test -- --run src/lib/collaboration-room.test.ts ../extensions/leafcode-collaboration/index.test.ts
```

17 tests passed。

### 残る制約

- coordinator 再起動後の orphaned lease は、同じセッションが `reserve` し直せば回収できる
- hardlink (`nlink > 1`) のファイルは今も予約・編集できない（web-build-mirror は `src/` を copy している）
- 切断後の clean lease は従来どおり TTL で解放する

## 2026-08-23: 巻き戻し「ユーザーメッセージのみ入力欄に戻せます」修正

### 症状
ツール実行後など、ユーザーメッセージの「入力欄に戻す」や undo 巻き戻しで
「ユーザーメッセージのみ入力欄に戻せます」エラーが出る。

### 原因
`snapshotMessages`（`web/src/lib/pi/harness.ts`）が Pi セッション entry id を
`stored[index]` のインデックスで `projectPiMessages` 出力に割り当てていた。
`toolResult` は UI に独立メッセージとして出ない（assistant の tool パートへ merge）ため、
その後の user メッセージの id が `toolResult` entry を指し、
`revertTask` の `entry.message.role !== "user"` チェックで拒否されていた。

### 修正
- `web/src/lib/pi/messages.ts` に `piRawMessageProjectsToUi` /
  `entryIdsForProjectedMessages` を追加
- `snapshotMessages` で project 出力と同じ順序で entry id を割り当て
- `messages.test.ts` に toolResult 挟み込み時の id 整合テストを追加

### 関連 API
- `POST /api/tasks/[id]/revert` — `entryId`（UiMessage.id = セッション entry id）
- `revertTask` / `messageEntryById` in `harness.ts`

## 2026-08-23: leafcode-collaboration 編集ブロック（hardlink + orphaned lease）

### hardlink（11db897）
- `web-build-mirror.mjs` が `web/src/**` を hard link → `nlink>1` で協調編集拒否
- 恒久対策: `src/**` は byte copy（約 1.4MB）。`syncMirror` で既存 link を自動移行

### orphaned lease（f7a3b61）
- `reserve` 成功後の `edit` が `Lease is 'orphaned'` 等で失敗
- 原因: mutate が orphaned を選択、同一 session の reserve が自分の orphaned を conflict、reconnect で connectionId 変化
- 修正: active/dirty のみ mutate、orphaned reclaim、connectionId 安定化、reserve 応答に leaseId
- 手順: `reserve` → 応答の leaseId 確認 → 直後に edit。reconnect 後は再 reserve

### runtime WeakMap キー（ea1746f、不十分）
- `WeakMap<sessionManager>` では、sessionManager 自体が tool ごとに新しい場合に再発する
- sessionId + cwd の Map に置き換えた（上記 2026-08-23 節）

## 2026-08-23: 協調「競合1件」の解消手段が UI に無かった

バッジとバナーが `leaseConflicts` の件数だけ出し、どのファイルか・どう直すかを示していなかった。`takeover` は Phase 3 未実装で、エージェントの `leafcode_collab release` も clean lease 以外は失敗する。

### 仕様

件数は `invalid` / `orphaned` のファイル予約。切断後に残った予約、または予約後の外部変更。自動では消えない。

### 修正

- GET `/api/collaboration` が衝突の所有者・パス・状態を返す
- タスク画面の警告に説明と「予約を解除」を出した。作業ツリーは残す
- POST `/api/collaboration` `{ action: "discard", leaseId }` が coordinator 経由で orphaned/invalid だけ released にする
- 所有セッションを再開して同じパスを `reserve` すれば従来どおり回収できる

### 検証

```
npx vitest run src/lib/collaboration-room.test.ts src/lib/collaboration-room-status.test.ts src/components/CollaborationStatus.test.tsx
```

28 tests passed。localhost:3011 のホームは回帰なし（このデータディレクトリにはプロジェクトも衝突も無い）。

## 2026-08-23: 協調警告がタスク画面に見えなかった

前回の「予約を解除」はチャットのスクロール領域とバッジの `title` / `aria-label` にしか出ず、件数テキストも画面に無かった。サイドバーのバッジはプロジェクト名ボタンの内側だったので、押すとホームへ飛ぶだけだった。ホームには警告自体が無かった。

### 修正

- バッジを独立ボタンにし、本文に「競合N件」を出す。押すとダイアログで説明と解除
- タスク画面の警告はヘッダー直下に固定。チャットをスクロールしても消えない
- ホームでも選択中プロジェクトの警告を入力欄の上に出す
- 文言は「ファイル予約の競合」。lease という内部語は出さない

### 検証

`CollaborationStatus.test.tsx` 4 tests passed。localhost:3011 でサイドバー「競合1件」→ダイアログ「予約を解除」、ホームのバナー、タスク画面ヘッダー直下のバナーを確認した。

## 2026-08-24: 生成機能移植計画の調査

本家 LeafCode のタイトル / NextAction / コミットメッセージ生成と、LeafCodePi の Pi `ModelRuntime`・設定同期・タスク/SSE・Git UI を照合した。実装はまだ開始していない。

- OpenCode の一時セッションは Pi の `SessionManager.inMemory()` + `createAgentSession({ noTools: "all" })` へ置換する
- 生成モデル設定は `generation-model` / `generation-model-effort` を `createSettingSync` と `ProviderModelsPanel` に接続する
- 生成モデル未設定時はタスク選択モデル、次に有効モデル先頭へフォールバックし、既存の決定論的タイトル/コミット文を最終フォールバックにする
- `gh` は未導入だが、GitHub raw/API で本家ソース調査は完了

## 2026-08-24: Goal Loop の結果JSON欠落リトライ修正

結果JSON欠落時の再試行が検証ターンを通常ターンへ戻し、最大ターンの最終ターンでは再試行されない問題を修正した。再試行は同じターン番号を保持し、`GoalLoopDto` と旧状態読み込みにも `unreadableStreak` を追加した。

検証: 拡張テスト16件、Web関連テスト5件、typecheck、lint。コミット `449e37e`。

## 2026-08-24: 画面分割ペイン幅のドラッグ調整

`TaskPanesHost` の分割境界をドラッグで調整できるようにした。最小幅を維持し、4ペインの2列グリッドにも対応。キーボードの矢印/Home/Endでも調整できる。

検証: `npm test`（Web 515 tests、host 108 tests）、typecheck、lint。コミット `af09c76`。

## 2026-08-24: キュー/割り込み送信の移植

本家 LeafCode に合わせ、TaskView に「キュー」/「割り込み」の送信方式選択、キュー待ち表示・削除・処理終了後の自動送信を追加した。API と Pi harness では `streamingBehavior: "steer" | "followUp"` を受け渡す。

検証: lint、typecheck、production build、追加テスト、Web 全体テストを実行。全体テストは別作業中の `thinking-levels` 未コミット変更に起因する既存テスト2件のみ失敗。コミット `7aa93c9`。

## 2026-08-24: セッション一覧のToDo進捗

タスク概要へToDo完了数を追加し、セッション一覧のタスク下にアクセシブルなプログレスバーを表示した。稼働中セッションはメモリ上の状態、既存セッションは保存済み履歴から進捗を復元する。

検証: Web 全体テスト525件、typecheck、lint。コミット `09e25b0`。

## 2026-08-24: プロジェクト追加画面のExplorer風改修

追加ダイアログをサイドバー＋フォルダー一覧のExplorer風レイアウトに変更。クイックアクセス、OneDrive、登録済みプロジェクトを候補表示し、既知のOneDriveルートを安全な参照許可ルートへ追加した。

検証: 対象ファイルのlint、browse-pathsテスト4件、対象ファイルのtypecheck確認。コミット `2ce6fc1`。

## 2026-08-24: スマホ幅のTaskView横はみ出し

TaskViewルートに`min-w-0`がなく、長いtoolサマリーのmin-content幅（約866px）でflex item全体が900pxへ拡張されていた。`min-w-0`を追加して375px実測のscrollWidthを375pxへ修正。コミット `02c96b8`。

## 2026-08-24: Ornith 思考付き最適化プリセット

ローカル llama-server のモデル選択に、Ornith-1.5 の思考付き・KV キャッシュ K/V q8_0 最適化プリセットを追加。同一モデルの複数プリセット選択時も設定と表示が一致するようにした。

検証: Web 全体テスト557件、typecheck、lint。コミット `2a2c2ae`。

## 2026-08-24: APIプロバイダーを生成モデルに追加

生成モデル設定を llama-server / Ollama Cloud の固定一覧から、`/api/models` に出る認証済みのAPI・サブスク・ローカル全プロバイダーへ拡張。llama-server は既存のOpenAI互換直結、その他は Pi `ModelRuntime.completeSimple` でエージェントセッションなしに直接実行する。コミット `c4c77d6`。

検証: 対象テスト8件、typecheck、lint、production build。Web全体テストはReact.act不整合等の既存環境エラーで525 passed / 43 failed。

## 2026-08-24: Ollama CloudをPiランタイム経由に統合

Ollama Cloudも固定URL/APIキーの手動直結を廃止し、他のAPIプロバイダーと同じ `ModelRuntime.completeSimple` 経路へ統合。認証とOpenAI互換アダプターをPi側へ集約した。コミット `64d14bb`。

検証: direct-generationテスト5件、typecheck、lint成功。production buildは別作業中の `TaskPanesHost.tsx` の `useSearchParams()` による Suspense境界エラーで失敗。

## 2026-08-24: 直接生成の不要な解決処理を削除

Ollama Cloud移行後に残っていたプロバイダー解決型・固定プロバイダー解決テストを削除し、llama-serverの固定エンドポイント処理を生成関数内へ整理した。コミット `701f401`。

検証: direct-generationテスト4件、typecheck、lint、production build成功。

## 2026-08-24: 直接生成変更のレビュー・最終チェック

直近のAPIプロバイダー／Ollama Cloud直接生成変更をレビュー。呼び出し経路、入力境界、固定llama-server URL、Pi runtime認証経路に追加の本番コード不具合は確認されなかった。通常環境の全体テスト失敗は `NODE_ENV=production` と認証環境変数の継承が原因で、環境を正規化すると全567テストが成功した。

検証: 対象テスト7件、全体テスト（環境正規化）567件、typecheck、lint、production build成功。コード変更なし。

## 2026-08-24: 直接生成のエラー握りつぶし修正

`completeModelText` が Pi `completeSimple` の戻り値を無条件にテキスト抽出しており、API 失敗時（stopReason=error/aborted）も「プロバイダーの応答にテキストがありません」となり実際のエラー（認証・レート制限等）が失われていた。stopReason チェックを追加し errorMessage を伝播。回帰テスト `harness-complete.test.ts`（globalThis state 注入でスタブ runtime を使用）。コミット `e04d692`。

検証: 新規テスト3件、direct-generation/settings 関連10件、tsc、eslint 成功。

判明した事実: Web全体テストの43失敗はシェル環境の `NODE_ENV=production` が vitest に継承され production react ビルド（React.act 未定義）が読まれるのが根因。既知の環境起因であり機能とは無関係。

## 2026-08-24: テスト環境の NODE_ENV・WebUI 認証 env 漏れを解消

vitest.config.ts の `test.env.NODE_ENV="test"` 強制で React.act 43件失敗を解消（production react ビルド読み込みが根因）。webui-auth テストは `vi.stubEnv` で LEAFCODE_PI_WEBUI_* を固定し、サーバー起動シェルからの env 漏れに依存しないよう修正。Web全体 579 テスト全通過。コミット `5545aae`。

注意: bash ツールのシェルには実行中サーバー由来の env（NODE_ENV=production、NEXT_*、LEAFCODE_PI_WEBUI_* 等）が漏れている。テストは環境変数を自分で固定すること。

## 2026-08-24: 生成モデルのEffort設定

タイトル / NextAction / NextTaskの生成モデル設定にEffort選択を追加。モデル対応レベルをUIに表示し、`generation-model-effort`としてlocalStorageとサーバー設定へ同期。Pi `completeSimple`にはreasoningを渡し、llama-serverは既存のテンプレート変換を使ってQwen/OrnithのEffort形式へ変換する。コミット `1fdbd9e`。

検証: 関連テスト20件、全体テスト578件、typecheck、lint、production build成功。

## 2026-08-24: 生成提案エラーの可視化とコミット生成の整合

NextAction / NextTask が API の具体的な生成エラーを捨てて固定文言だけ表示していたため、プロバイダーエラーを alert に表示するよう修正。コミットメッセージも共通生成モデルの対象であることを設定画面に明記し、Effort・60秒timeoutを適用。AI生成失敗時は決定的フォールバックを維持しつつ理由をUIとログへ返す。設定中の `openrouter::stealth/ox-alpha` は履歴上400/429/502があり、429は共有上流プールの一時レート制限。今回の個別失敗理由は旧実装が捨てたため復元不能。コミット `0e3ad9c`。

検証: 関連7テスト、Web全体95ファイル/583テスト、typecheck、対象lint成功。

## 2026-08-25: 生成機能の動作調査

タイトル / NextAction / NextTask / コミットメッセージの実装経路を確認。関連27テスト、Web全体591テスト、host 108テスト、typecheck成功。lintは既存warning 1件。実プロバイダーを使うE2Eは未実施、production buildは稼働中判定のport 3010でラッパーに拒否された。コード変更なし。

## 2026-08-25: スキル呼び出しの生XML表示

Pi の `/skill:name` は user message 内を `<skill ...>` エンベロープへ展開するが、WebUI の PartView が user text としてそのまま描画していた。PartView でスキル名を折りたたみ表示し、末尾の追加指示を通常メッセージとして分離。コミット `ab9ddba`。

検証: PartView 4 tests、typecheck、対象 lint、production build 成功。Web 全体テストは別作業中の GlobalAttentionProvider テスト1件が失敗。

## 2026-08-25: スキル呼び出しをインラインハイライトへ変更

折りたたみカードを廃止し、展開済み `/skill:name` を既存の `ReferenceHighlight` と同じ青色ハイライトで表示。スキル本文はUIに出さず、追加指示だけ同じユーザーバブルへ残す。コミット `ea54aac`。

検証: PartView 4 tests、typecheck、対象 lint、production build 成功。

## 2026-08-25: スマホのGraph/Diffパネル表示

スマホ（md未満）ではコミットグラフとDiffを排他的に開き、チャット本文・Composer・補助バナーを隠してパネルをタスク画面いっぱいに表示する。md以上では従来どおり同時表示可能。コミット: `0324169`。

## 2026-08-25: コンテキスト圧縮後の会話履歴表示
`harness.snapshotMessages` は `session.messages`（圧縮後のLLMコンテキスト）ではなく現在ブランチのSessionManager履歴を投影し、圧縮前メッセージもUIに表示する。回帰テスト追加。コミット `cb37303`。

## 次の指示提案ボタンの余白
TaskView の NextAction と Composer が接触していたため、NextAction に下マージンを追加。コミット: `5df04c8`。

## 2026-08-25: Pi 0.84.3 の PowerShell 標準化

Pi を 0.84.3 に更新し、`~/.pi/agent/settings.json` の `defaultTools` を `["read", "powershell", "edit", "write"]` に設定。`~/.pi/agent/AGENTS.md` から OpenCode 固有の記述を削除し、PowerShell 既定・Bash 明示利用の手順に更新。

## 2026-08-25: Huihui-Qwen3.8-27B-abliterated 最適化プリセット

llama-server のモデル選択に Huihui-Qwen3.8-27B-abliterated 専用プリセットを追加。MTP 維持版として既存 Qwen3.8 と同じ `draft-mtp`、effort `low`、131K コンテキスト、KV キャッシュ K/V `q8_0` を適用する。コミット `b601835`。

検証: Web 全体648テスト、対象31テスト、typecheck、lint成功（既存warning 1件）。production build は稼働中の port 3010 を検出した build wrapper に拒否された。

## 2026-08-25: PowerShell既定化のエージェント影響対応

Pi 0.84.3 の PowerShell 既定化に合わせ、`~/.pi/agent/agents` の OpenCode由来・未提供ツール（`glob` / `webfetch` / `websearch`）を Pi 標準ツールへ整理。`question` は `leafcode-question` 拡張が提供するため、後続修正で復元した。WebUI の既定ツール、collaboration / permission gate、pi-subagents の診断・変異検出・表示を Bash + PowerShell 対応に更新。コミット `04d1f49`。

検証: Web 650 tests、typecheck、lint（既存 warning 1件）、PowerShell実行、エンコーディング検査、ラウンドトリップ検査。

## 2026-08-25: question拡張の復元

`leafcode-question` は Pi 拡張として `question` ツールを登録するため、グローバルパッケージ登録、WebUI既定ツール、元のOpenCodeロールで質問許可だった5エージェントのツール許可リストを復元した。WebUI側のコミットは `ca24ff8`。Pi標準には `glob` / `webfetch` / `websearch` はなく、`find`（glob検索）と PowerShell / `insane-search` を代替にする。

## 2026-08-25: Huihui-Qwen3.8 GGUFをダウンロード

公式 `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF` の `Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf` を `C:\Users\Daichi\models\llm\Huihui-Qwen3.8-27B-abliterated-GGUF` に配置した。サイズは16,810,714,400 bytes、SHA-256は `6c2c13cef89238c3604d756b07b3ef5fafebbd61095feb8553ff449c95e4c1c6`。

検証: HF dry-runで未取得ファイル0件、モデルプリセットテスト19件成功。mmprojは現行UIのテキスト運用では使わないため未取得。
## 2026-08-25: サブエージェントをハング監視から除外

親ターンで実行中の subagent / task ツールだけが残る場合は、親のハング watchdog が停止・再送しない。通常のツールが同時に走っている場合は通常どおり監視する。コミット: `a15d266`。

## 2026-08-25: マルチアカウント対応計画（OpenAI Codex + Anthropic）

docs/plans/multi-account.md に計画書をコミット（83432c0 + 最終レビュー修正 1f037a1）。設計の核: アカウント = ~/.pi/agent/accounts/<id>/auth.json を authPath に持つ ModelRuntime 複数インスタンス。default は既存シングルトンのまま。検証済み事実: Pi SDK の modelsPath はカスタムモデル設定（共有）、カタログキャッシュは modelsStorePath（アカウント別に分離、FileModelsStore にロックなし）。Pi の anthropic auth エントリに subscriptionType はない（CodexBar の Claude プラン表示は縮退）。agentDir の env は PI_CODING_AGENT_DIR。認証一覧 API は GET /api/providers。

追記（再レビュー 31dfe88）: アカウントストアは store.json を触らず dataDir 配下の別ファイル accounts.json へ（StoreFile が閉じた型+厳格バリデーションのため）。Composer 実ファイルは web/src/components/Composer.tsx。api/providers に route.test.ts は無く、テスト形式の拠所は codexbar/providers/route.test.ts。

## 2026-08-26: MetaTrader MCP Server導入

`metatrader-mcp-server==0.5.1` を `~/.pi/agent/mcp-venvs/metatrader` の Python 3.11 venv に導入し、`~/.pi/agent/mcp.json` に `metatrader` を stdio サーバーとして登録した。上流の依存指定が `mcp>=1.6.0` のため最新2.xでは `mcp.server.fastmcp` が壊れる。上流 `uv.lock` に合わせて `mcp==1.6.0`、`pydantic==2.11.3`、`pydantic-settings==2.8.1` 等を固定した。MT5端末・認証情報未設定のため、設定は `disabled: true` の安全な初期状態。

## 2026-08-26: mcp-mt5導入

`mcp-mt5==0.4.1` を同じ Python 3.11 venv に追加し、`~/.pi/agent/mcp.json` に `mt5-build` として登録した。これはライブ取引ではなく、MetaEditorでのMQLコンパイル・デプロイ・バックテスト・レポート解析用。MetaTrader端末未導入のため `disabled: true` を維持する。

## 2026-08-26: マルチアカウント対応 実装完了（OpenAI Codex + Anthropic）

docs/plans/multi-account.md 全Phase実装。コミット: 60de1ab(accountsストア)/fa6c5a4(getRuntimeFor)/3064a99(CRUD API)/7a2b21e(login・logout accountId)/5fb9606(タスクaccountId)/94a048b(設定UI)/ac650a4(Composer選択+models連動)/560df6c(TaskViewバッジ)/64eed8f(AccountRuntimeManager)/756ab30(harness結線)/dcf7c55(セッション参照解放)/cb7749e・84a1cc9(CodexBar Pi統合)/4ce6345(README)。

設計: アカウント=~/.pi/agent/accounts/<id>/auth.jsonを持つModelRuntime(AccountRuntimeManager: 同時acquire統合・refs保護・idle上限2 LRU)。default=従来シングルトン不変。createSession/createTask/POST /api/tasksがaccountIdを受ける。disposeLive()でrelease+evictIdle。CodexBarはpi-auth.ts経由でPi auth.json優先→CLIフォールバック(書戻しも読取元一致)。Pi由来Claudeはプラン・email非表示(subscriptionType/id_token未保存のため)。AccountSelectはアカウント0件で非表示。

検証: typecheck/lint(exit 0 既存warningのみ)/web 733テスト/host 110テスト全パス。OAuth実ブラウザフロー(手動確認リスト8項目)はユーザー側検証として残置。

## 2026-08-26: MetaTrader用スキル追加

`extensions/leafcode-subagents/skills/trading/SKILL.md` に `ariadng/metatrader-mcp-server` のTradingスキルをLeafCodePi向けに適応して追加し、`mt5-build/SKILL.md` に `PHUICMT/mcp-mt5` 用の環境確認・MQLコンパイル・デプロイ・バックテスト・レポート確認手順を追加した。Piの `pi.skills` 設定で既存の同ディレクトリが読み込まれる。コミット: `035ece1`（同コミットに別セッションのTaskView変更も含む）。

## 2026-08-27: CodexBarアカウント認証読み取りを削減

Codex / Claude のアカウント別provider instance内で、`isConfigured()` と直後の `fetch()` が同じPi OAuth認証を再読込していた。instance内だけで認証スナップショットを再利用し、各provider/accountの読み取りを2回から1回へ削減した。default scopeは外部CLI認証変更を取り込めるようキャッシュしない。回帰テスト追加、web 136 files / 791 tests、typecheck、lint（既存warning 8件のみ）成功。コミット: `31ae1b6`。

## 2026-08-27: CodexBar外部APIの接続タイムアウトを緩和

CodexBarのCodex/Claudeが全アカウントで `fetch failed` になった。Node組み込みfetchが接続確立10秒で `UND_ERR_CONNECT_TIMEOUT` を返していた一方、同じ環境のcurlとundiciの接続タイムアウト30秒設定ではHTTP応答を確認できた。共通`fetchText()`で該当エラーだけ設定済みundici Agentへ再試行し、通常エラーと認証情報は変更しない。回帰テスト、web 137 files / 793 tests、typecheck、lint、production build成功（build警告は既存の動的filesystem 3件）。コミット: `4e8e1af`。

## 2026-08-27: CodexBarのDNS解決停止が真因と判明（4e8e1afの後追い修正）

`4e8e1af` 後もエラーが続き、文言が `fetch failed` から `This operation was aborted` に変わった。切り分けで真因を特定: **Nodeの `dns.lookup`（getaddrinfo）が特定ホストで約12秒停止**する。実測 `dns.promises.lookup('api.anthropic.com')` = 12,074ms（family 4/6/unspec とも、再実行でもキャッシュ効かず）、対して `dns.resolve4/6`（c-ares直問い合わせ）= 57/63ms、`curl` の `time_namelookup` = 0.025s、`chatgpt.com`/`example.com` の getaddrinfo は 17〜60ms。つまりネットワークではなくOSリゾルバ経路の問題で、遅いホストは時期により変わる。12秒のDNS待ちがundiciの接続タイムアウト（既定10秒）を超え、`4e8e1af` の「標準fetchで10.7秒無駄に待ってからundiciへ再試行」構成では30秒予算を使い切ってabortしていた。

対策: `web/src/lib/codexbar/utils.ts` に `racingLookup()` を追加し、OSリゾルバとc-ares問い合わせを競走させて先着を採用（OSに50msの先行を与え hosts / MagicDNS 上書きを優先）。`fetchText()` はundici単一経路（`connect: { lookup }`、connectTimeout 20秒、autoSelectFamily）に統合し、二重fetchと `isConnectTimeout()` を削除。`connect` の中身が `net.connect`/`tls.connect` に渡ることは `node_modules/undici/lib/dispatcher/client.js:242-251` と `lib/core/connect.js:62-114` で確認。

検証: 実コード経路のライブ実測でchatgpt=401(164ms)/anthropic=401(222ms)/openrouter=401(87ms)/cursor=404(542ms)、合計561ms（従来12秒停止→タイムアウト）。web 137 files / 796 tests、typecheck、lint（既存warning 8件のみ）、production build成功。コミット: `27c799e`。

副次: codexbarテストは `vi.stubGlobal("fetch")` では効かなくなるため、`vi.mock("undici", importOriginal)` で `fetch` のみ差し替える方式へ4ファイル移行（`providers-auth.test.ts` は改行を挟んだstubのためgrepで見落としやすく、放置すると実ネットワークへ出る）。

残課題: `[commandcode] Could not refresh the Command Code model catalog (... timed out after 10000ms)` は `pi-commandcode-provider` 側の別経路（Node組み込みfetch）で同じDNS停止を踏んでいる可能性が高いが未修正。`fetchText` 経由でないため今回の修正は届かない。

## 2026-08-27: モデル一覧で統合プロバイダの並び順が無視される不具合

症状: 設定画面のモデル並び替え（Codex→Claude→ollama-cloud→…）がComposerのモデル選択に反映されず、Codex / Claude が他プロバイダより後ろに出る。

真因: `provider-model-state.json` の `providerOrder` には**2種のキー形式が共存**する。設定画面は統合モードの行をプロバイダキー（`openai-codex`）で保存し、`mergeKnownOrder()` が過去のアカウント別キー（`<accountId>::openai-codex`）を末尾に温存する（モード切替時の順序保持のため意図的）。実データは plain 9件（index 0-8）＋アカウント別4件（index 9-12）。設定画面の並び計算（`harness.ts` の `listProviderModelsCatalog` 内 rank）は plain キーを先に見るのに対し、モデル一覧の `buildModelsForAccounts()` の `rowRank` は `accountRowRank()` 経由でアカウント別キーを優先していた（`accountRowRank` は `accountId::provider` → `provider` の順に解決）。結果 Codex=9 / Claude=12 となり commandcode(8) より後ろへ沈んだ。ユーザー環境は `provider-routing.json` で両者 `integrated`。

修正: `web/src/lib/pi/harness.ts` の `rowRank` で、統合モードのオプションは `rowOrder.get(providerID)`（表示中の行と同じキー）を最優先し、無い場合のみアカウント別キーの最小値へフォールバック。`accountRowRank` 自体は統合グループ内のアカウント順で使うため変更しない。

回帰テスト: `harness-runtime.test.ts` の "orders integrated providers by the settings row order"。`providerOrder: [openai-codex, llama-server, <acc>::openai-codex]` で実データの形を再現し、修正前は `[llama-server, openai-codex]` で失敗、修正後 `[openai-codex, llama-server]`。テスト作成時の落とし穴: `saveProviderModelsOrder()` / `setAccountRoutingMode()` が `invalidateHealthCache()` で `modelCache` を破棄するため、共有プロバイダのモデルは**順序保存の後に** seed する。

検証: web 137 files / 797 tests、typecheck、lint（既存warning 8件のみ）、production build 成功。コミット: `6ee19e3`。

## 2026-08-27: マルチアカウントレビューの追加修正

Command Code の canonical env (`COMMANDCODE_API_KEY`) を usage resolver でも優先し、`AccountRuntimeManager` の acquire/idle eviction 競合と再利用時LRU順序を修正。セッション登録のaccount runtime参照取得を同期化し、direct completion中もaccount runtimeを参照保持するようにした。ログインpromptのAbortSignal listenerはanswer/cancel/error時に解除する。

回帰テスト追加。Cursor `@rahularya01/pi-cursor` v1.4.25 はfactoryごとのclosure内tokenで、現行のruntime分離では共有token競合を再現しなかった。OpenCodeとOpenCode Goの登録/catalog差異も用途別（Pi provider / CodexBar usage-only）で問題なし。

検証: Web 139 files / 826 tests、typecheck成功、lintエラーなし（既存warning 8件）、`LEAFCODE_PI_PORT=3011 npm run build`成功。変更はユーザーの明示的commit指示がないため未コミット。

## 2026-08-28: Composer既定エージェントをbuildへ統一

TaskViewのagent stateが空で、AgentSelectの表示フォールバック「エージェント」が出ていた。`resolveAgentSelection()`を共通化し、TaskView/Home/AgentSelectでbuildを優先、不明値・空値・旧プレースホルダーを実在する候補へ正規化。SSEとキャッシュからタスク固有のagentも復元し、プレースホルダーをoptionへ戻さない回帰テストを追加。コミット: `d1f9518`。

検証: 対象10 tests、Web 142 files / 837 tests（`--testTimeout=30000`）、host 110 tests、typecheck、lint（既存warning 8件）成功。標準タイムアウトの全体実行は環境負荷で既存テストが一時的にtimeoutしたが、タイムアウト延長後に全パス。

## 2026-08-28: 設定モデル画面のプロバイダーを最下段へ移動

設定→モデルの表示順を「モデル」「生成モデル」「プロバイダー」に変更し、SettingsView の回帰テストを更新。コミット: `bef804e`。

## 2026-08-28: プロバイダー有効化時の子モデルを無効化

設定→モデルでプロバイダーを有効化した際、子モデルをすべてOFFにして個別選択を要求するように変更。回帰テストと統合アカウント対応を追加。コミット: `0211473`。

## 2026-08-28: production build failure の再確認

`npm run build` を実行したが、Turbopack・TypeScript・静的ページ生成を含めて成功。ビルド失敗は再現できず、継続時はエラーログが必要。

## 2026-08-28: Goal Loop turn 1 の性能ベースライン

変更前の全体テストは Web 143 files / 841 tests、host 110 tests が成功し、`npm run typecheck` も成功した。Web lint はエラーなし・既存 warning 8件（`task-session-cache.ts` の未使用 destructuring）が残る。稼働中 WebUI の `/api/health` は5回とも HTTP 200、TTFB 4.1〜5.5ms。`npm run build` は稼働中の port 3010 を build guard が検出して実行を拒否したため、サーバーを停止せず未実施。次の候補は `emitTaskDelta()` が100msごとに履歴全体を再投影・走査している経路の計測と縮小。

## 2026-08-29: sysmon混在GPUの自動検出

NVIDIA GeForce RTX 3060 Ti と AMD Radeon AI PRO R9700 の混在時、AMD LUID未指定でAMD側が非表示になる問題を修正。DXGIのAdapterLuid/VendorIdでAMDのGPUパフォーマンスカウンターを自動特定し、NVIDIA・AMD（内蔵GPUを含む）を同時表示する。コミット: `af89143`。

検証: 実機GPU統合テスト、Web全体838 tests、host 114 tests、typecheck、lint、production build、PowerShellエンコーディング検査・ラウンドトリップ成功。

turn 2 の合成ベンチマークでは、履歴100/1,000/5,000件を各200回 delta 更新した場合、現行の全体投影経路はそれぞれ3.03/20.72/71.93ms（テスト内計測）だった。計測用テストは実行後に削除済み。履歴5,000件では約0.36ms/回で、次は末尾メッセージだけを投影する実装と同じ条件で比較する。

## 2026-08-28: SSE delta の末尾メッセージ投影

`harness.ts` の `snapshotMessages(..., latestOnly)` を追加し、キャッシュ済み履歴がある高頻度 delta では末尾メッセージだけを投影・throughput/tool状態へ反映するようにした。履歴100/1,000/5,000件を各200回、全体経路と比較すると 4.05/18.54/68.24ms に対して 1.50/0.65/0.37ms。ブランチ読込なしの回帰テストと typecheck / lint を確認し、計測用テストは削除済み。

## 2026-08-28: Goal Loop turn 4 の実SSE確認

認証済みの稼働中 WebUI へ `/api/tasks` を照会し、タスク49件・実行中0件を確認。既存アイドルタスクの events endpoint は HTTP 200 で、初期 `snapshot` を2件受信し、先頭は `eventType=bootstrap`・メッセージ0件だった。実行中タスクが無いためdelta発生までは確認できず、既存タスクへプロンプト送信や稼働中WebUI再起動は行わなかった。

## 2026-08-30: permission-gate設定のプロジェクト外保存

`permission-gate.json` の保存先をプロジェクト内の `.pi/leafcode/` から `dataDir()`（既定 `%APPDATA%\leafcode-pi`）へ移動。拡張側も同じ保存先を読み、`bindExtensions()` 後に明示モードを再適用してセッション開始時の上書きを防止。既存のプロジェクト `.pi` 生成物は削除。コミット `802aafd`。

検証: permission-gate関連5 tests、host 114 tests、lint成功。Web全体は既存の Auto モデル設定テスト1件、typecheckは同設定の既存型エラー3件で失敗。

## 2026-09-04: System safety guard の過検知を緩和

観点: hard-gate がコーディングエージェントの日常操作（`node -e` / `bash -c` / `Start-Process` / ホーム配下の mkdir・書き込み / MCP の run・execute 名 / プロンプト文面の危険語）まで調査→計画→明示承認フローに巻き込んでいた。

### 変更
- `dynamic/elevated script execution` を EncodedCommand / iex / eval / 難読化呼び出し / 変数+危険動詞 / リモート Invoke-Command に限定
- ソフトラッパー（`bash -c` / `node -e` 等）は外側だけでは hard せず、ネスト中身を再分類
- user-data（Users/home 配下の変更）を hard-gate から外す（破壊的操作は DANGEROUS_PATTERNS / protected-paths で継続保護）
- MCP ツール名の単独 `run`/`execute` マッチを削除。`prompt`/`message`/`query` をコマンド走査キーから除外し全 leaf 文字列スキャンを廃止
- 調査 allowlist を OS/disk 向けに少し拡張

### 維持
- OS 停止・権限昇格・パッケージ/サービス/レジストリ/disk/firmware、`"$x" stop`、`& ('Stop-'+'Computer')`、curl|sh、LeafCodePi 自己停止禁止

検証: `extensions/leafcode-permission-gate` 7 tests、`pi-args.test.ts` 3 tests 成功。
## 2026-09-05: システム安全ガードを設定から無効化可能に

設定 > エンジン に「システム安全ガード」トグルを追加。`permission-gate.json` の `systemSafety: false` を API (`/api/settings/system-safety`) 経由で読み書きする。無効時も保護パスと LeafCodePi 自己停止禁止は維持。デフォルトは有効。

検証: permission-gate-config / system-safety API / SystemSafetySettings / SettingsView / extension index の関連テスト成功。
## 2026-09-05: システム安全ガードの度合い調整

設定 > エンジンの安全ガードを ON/OFF から 4 段階へ変更。

- `off`: 無効（保護パス・自己停止禁止は継続）
- `low`: 停止/権限昇格/kernel/driver/boot/disk/firmware のみ、確認1回
- `standard`: OS変更系すべて、確認1回（調査・計画なし）
- `strict`: 従来どおり調査→計画→明示承認（デフォルト）

`permission-gate.json` の `systemSafety` は string level。旧 boolean は off/strict に互換変換。API は `{ level, systemSafety }` を返す。

検証: web 関連 30 tests、permission-gate 11 tests 成功。
## 2026-09-05: 安全ガード既定を標準にしスライダUI化

システム安全ガードのデフォルトを `strict` から `standard` に変更。設定UIは select から range スライダ（無効→軽め→標準→厳格）へ。旧 boolean `true` も standard へマップ。

検証: web 関連 14 tests、permission-gate 11 tests 成功。
## 2026-09-05: 標準度合いで git show 等を確認不要に

- 標準/軽めは致命的な機械操作（停止・権限昇格・kernel/driver/boot/disk/firmware）のみ確認
- `.git` / `node_modules` の読み取り（`git show`、`Get-Content .git/HEAD` 等）はブロックしない。書き換えは継続ブロック
- `.env` / `.ssh` / `.aws` は読み取りもブロック維持

検証: permission-gate 11 tests、SystemSafetySettings / system-safety 3 tests 成功。

## 2026-09-05: safety-gate ループ停止

ユーザー「終了」により AGENT_LOOP_TICK_safetygate（2分間隔）を停止。端末 status=aborted、PID 29240 は既に不在。ギャップ調査・修正は継続しない。

## 2026-09-18: 停止中の llama-server をモデル一覧から除外

llama-server が停止（`/models` 無応答）のとき、`web/src/lib/pi/llama-provider.ts` の `resolveModelRows` はモデルを 1 件も登録しないようにした。設定 `modelFile` から推測した id を残していたため、停止中でも生成モデル・起動時の既定値・Autoモデル・エージェント・Composer の各ドロップダウンに、選択しても動かない llama-server 項目が並んでいた。起動中は従来どおり `/models` の live id を列挙する。停止→起動の切り替えは `/api/llama-server/(start|stop)` の `invalidateHealthCache()` で即反映される。

検証: `web/src/lib/pi/llama-provider.test.ts` 16 tests 成功、web typecheck / eslint 成功。全体テストの失敗 4 件（bot-code-relay 2、harness-limit-fallback 1、TaskView.resume 1）は変更前の stash 比較でも同一で無関係。
