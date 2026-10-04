# LeafCodePi 安定性監査（2026-10-04）

読み取り専用スキャン。製品ソース・テストは未変更。最適化メモ（`OPTIMIZATION-AUDIT-2026-10-04.md`）の CPU／ポール観点、およびバグ性能メモの既掲載ホットスポットは、ここでは「落ちる・壊れる・二重実行・状態が分裂する」ものだけを新規として扱う。

| 項目 | 値 |
| --- | --- |
| 日付 | 2026-10-04（Asia/Tokyo） |
| HEAD | 第1–5巡 `aeeb43ee`（`aeeb43eeaddb218e338e122288ac0f0c6e54c77c`）。第6巡 `28f55360`（`28f553600fdb7897ebe4123fe1370e21cea6fd6d`、13:35 JST） |
| リポジトリ | `C:/Users/Daichi/Desktop/LeafCodePi`（X870） |
| 件数 | **高 16 / 中 32 / 低 12**（合計 **60**；第1–5巡50 + 第6巡10） |
| 方針 | 永続化の消失、ロックの奪い合い、中断後の二重実行、シャットダウン漏れ。性能だけの指摘は載せない |

## 優先度サマリ

| 優先 | 件数 | 狙い |
| --- | --- | --- |
| **P1 高** | 16 | 上記＋Goal Loop の cooldown 破棄、ハング停止の再キュー、再起動ガードの死角 |
| **P2 中** | 32 | 上記＋workflow-state のロック盗取、Stop がループを再開する |
| **P3 低** | 12 | 上記＋壊れた nextTurnAt、空の pauseReason |

## 推奨着手順

1. **#1** 壊れた `store.json` を空として書かない（読取失敗は mutate を拒否）
2. **#2** `withDirectoryLock` を owner トークン付き解放に揃える（accounts / rooms / agents / skills / routines / peer-auth）
3. **#12** abort が例外でも idle とリース解放まで進む
4. **#3 / #4** Goal Loop の非原子上書きと、hang-watch の空読み込みで全監視が消える経路
5. **#14 / #33** host.lock の開始時刻と、Web+Backend の二重所有者

---

## P1 — 高（第1巡 #1–#4）

### 1. 壊れた `store.json` を空ストアとして次の更新が永続化する

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/app-store.mjs` `#readStore` ~45–61、`#mutate` ~22–31、`#writeStore` ~78–86 |
| 症状 | パース失敗・`version` 不一致・配列でない `projects`/`tasks` は例外にせず `emptyStore()` を返す。`#mutate` はその戻り値の上で insert/patch し、原子 rename で **本物のファイルを空に近い内容へ置換**する。一時的な共有違反や 0 バイトでも同じ |
| 対比 | `peer-auth-grants.mjs` は破損時 500 で書かない |
| 提案 | ファイルが存在するのに解釈できない場合は書込を拒否し、バックアップから復元するまで mutate しない。欠落ファイルだけ空を許す |

### 2. `withDirectoryLock` が生存中のロックを時刻だけで削除し、`finally` が他人のロックも消す

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/directory-lock.mjs` ~16–33 と async 版 ~40–58。利用: `web/src/lib/accounts.ts` ~248、`rooms.ts` ~53、`agents.ts` ~366、`routines.ts` ~67、`peer-auth-grants.mjs` ~76 |
| 症状 | `staleMs`（口座・部屋・エージェント設定は 30s）を超えると **PID も owner も見ずに** `rmSync`。遅いウイルススキャンや巨大 JSON の RMW 中に第二ワーカーが入る。元の `finally` は `lockPath` を無条件削除するため、奪った側のロックまで消し、第三者が臨界区間に入る |
| 対比 | `file-lock.mjs` ~76–78 と hang-watch の解放は owner 文字列一致のときだけ削除する。盗取側にはその検査がない |
| 提案 | 取得時に owner ファイルを書き、stale 削除は「プロセス不在かつ開始キー不一致」のときだけ。解放は自分の owner のときだけ |

### 3. Goal Loop が rename 失敗で対象ファイルを直接上書きし、成功時に他人の temp まで消す

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-goal-loop/index.ts` `writeLoop` ~674–708、`cleanupOrphanGoalTemps` ~639–649、`recoverLoopFromTemp` ~586–590 |
| 症状 | Windows の EPERM/EBUSY で短いリトライのあと `writeFileSync(file, content)` に落ちる。クラッシュすると本ファイルが途中までになり、読取側はループ消失に見える。成功時は `cleanupOrphanGoalTemps` が **同じ basename の temp を全部**消す。並行するもう一方の書込 temp が巻き込まれ、そのスナップショットは復旧できない |
| 提案 | 直書きフォールバックをやめる。temp 削除は自分のパスだけ。本ファイルが JSON として閉じていない間は前世代を残す |

### 4. hang-watch のディスク読取失敗が「監視ゼロ」になり、メモリ上の全行を捨てる

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/hang-watchdog.ts` `readStore` ~145–147、`syncMemoryFromDisk` ~306–313。tick は ~716–720 で毎周期これを呼ぶ |
| 症状 | `hang-watches.json` が一時的に読めない、または version が合わないと `{ watches: [] }`。`memoryWatches.clear()` のあと空を載せる。以降の tick は armed 行を見ないので、ハングしても abort/再試行しない。空を書き戻す経路があると恒久的に消える |
| 提案 | 読取失敗は前回メモリを維持し、空配列の上書きを禁止する。temp 復旧（起動時の `recoverInterruptedHangWatches`）を tick 側でも使う |

## P2 — 中（第1巡 #5–#9）

### 5. 再起動再開の試行予算がロック無しで、壊れたファイルだと回数を忘れる

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/restart-resume.mjs` `readAttempts` ~53–66、`claimAttempt` ~77–89。上限は `RESTART_RESUME_MAX_ATTEMPTS = 2` |
| 症状 | 読取→変更→`writeAttempts` がプロセス間で直列化されていない。二つの Backend が同じ中断タスクを両方再開しうる。パース失敗は `{}` を返し、次の成功書込で **予算ファイル全体を置換**する。壊れている間は 2 回上限が効かず、中断プロンプトが繰り返される |
| 提案 | `store.json` と同じロックで claim する。解釈不能なファイルは「予算不明＝再開しない」 |

### 6. 部屋履歴の重複排除が末尾 256KB だけで、それより前の再送は二重になる

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/room-store.mjs` `HISTORY_DEDUPE_TAIL_BYTES` ~10、`recentHistoryIds` ~12–30、`archiveOverflow` ~149–160 |
| 症状 | 履歴へ append したあと部屋ファイルの rename が失敗すると、同じメッセージが再アーカイブされる。重複判定は末尾 256KB の id だけなので、バッチが大きいと先頭 id が窓の外に出て **history.jsonl に二重行**が入る。`appendFileSync` 自体もプロセスをまたぐと行が混線しうる（部屋ロックが #2 で破れると顕在化） |
| 提案 | 追記前に id を別索引（またはハッシュ）で持ち、窓を超えた再送でもスキップする。append はロック内の単一ライタに固定 |

### 7. Bot 設定の shape 移行が未知フィールドを落として書き戻す

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/bot-config.mjs` `parseBotConfig` ~108–134。書込は `bot-store.mjs` `writeConfig` ~36–41 |
| 症状 | ツール名だけの移行は `{ ...value, tools }` で未知キーを残す、とコメントにある。一方 `needsShapeRewrite`（avatar / label / notifications / codeAutoApprove の型が古い）は **再構築した `config` だけ**を書く。新しいビルドが足したフィールドは、古いビルドが一度読んだだけで消える。`readConfig` は一覧のたびにこれを通りうる |
| 提案 | shape 移行も未知キーを保持する。移行書込は世代番号が上がるときだけ |

### 8. SOUL.md / MEMORY.md が原子的でない

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/bot-store.mjs` `writeSoul` ~67、`ensureMemoryFile` ~69–71。対して `writeConfig` は temp+rename |
| 症状 | クラッシュや強制終了で Markdown が途中までになる。SOUL はプロンプトにそのまま載るので、次ターンが壊れた人格テキストで走る。`ensureMemoryFile` は存在チェックのあと無条件 `writeFileSync` で、競合すると既存メモリを空テンプレで潰しうる |
| 提案 | config と同じ temp+rename。作成は `wx` |

### 9. タスクリースの heartbeat 失敗を無視し、持ち主のまま他プロセスに渡る

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/task-runtime-lease.mjs` `#touchTaskLease` ~77–88、`#leaseActive` ~65–67、`acquireTaskLease` ~144–156。`TASK_LEASE_STALE_MS = 60_000` |
| 症状 | ディスク満杯や共有違反で heartbeat の rename が失敗しても catch して続行する。`ownedTasks` には残るのでこのプロセスは実行を続ける。60 秒後に他ワーカーが stale と判断して同じタスクのリースを取り、**二つのランタイムが一つの Code セッションを進める** |
| 提案 | 連続失敗で自分からリース喪失を通知し、プロンプトを止める。書込失敗を成功扱いしない |

## P3 — 低（第1巡 #10–#11）

### 10. AppStore がキャッシュの実オブジェクトを返す

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/app-store.mjs` ~52–58（raw が一致すると `cached.value` を返す）、`getTask` ~164。リース側コメント `task-runtime-lease.mjs` ~230 も「patch 中にキャッシュ行を変えうる」と認めている |
| 症状 | 呼び出し側が返却タスクのフィールドをその場で書くと、ロック外の変更が次の `#writeStore` に混ざる。raw 比較はディスク文字列なので、メモリだけ汚れたオブジェクトを「未変更」とみなして返す |
| 提案 | 読取は構造化クローンか凍結した DTO。更新は `#patchTask` のみ |

### 11. Bot `writeConfig` は失敗 temp を残す

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/bot-store.mjs` ~32–41（コメントが「失敗時は temp を残す」と明記）。部屋の `writeRoom` は `finally` で temp を消す |
| 症状 | rename が繰り返し失敗すると `config.json.<pid>.*.tmp` が溜まり、同期ツールやウイルス対策がディレクトリを掴んでさらに rename が失敗する。安定性の二次障害 |
| 提案 | 失敗時は temp を削除。成功後の掃除は自分の temp だけ |

### 第1巡で見たが優先度を上げなかったもの

- AppStore の日次バックアップは COPYFILE_EXCL でその日の先頭だけ（#32 で低として記録）
- `keyed-serializer.mjs` のチェーンは失敗を次に伝えない（この点は健全）
- peer-auth は破損ファイルを上書きしない（#1 の対比）

---

## 第2巡（2026-10-04 Asia/Tokyo）— 中断とプロセス同一性

第1巡 #1–#11 は再掲しない。本巡は abort の途中失敗、拡張のシャットダウン、host / refresh / file ロックの PID 扱い、ルーティンの長時間クレーム。

| 項目 | 値 |
| --- | --- |
| HEAD | `aeeb43ee` |
| 本巡の新規 | **高 3 / 中 6 / 低 2**（合計 **11**；#12–#22） |
| 累計 | **高 7 / 中 11 / 低 4**（合計 **22**） |

### 12. [高] ユーザー停止もハング停止も、スナップショット例外で idle 化せず抜ける

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/abort-coordinator.mjs` `runUserAbort` ~36–50、`runHangWatchdogAbort` ~88–105 |
| 症状 | セッション abort は先に起動するが、`snapshotMessages` / `stopGoalLoop` / `stopSubagentRuns` / `emitHangAbort` が throw すると `setIdle` と `releaseLease` に到達しない。SDK 側は止まっているのにタスクは `working`、リースは保持されたまま。UI の停止ボタンが戻らず、次のプロンプトはリース競合で拒否されうる |
| 提案 | idle 化とリース解放を `finally` に置く。ハング側は「新しい watch に置き換わった」ときだけスキップする現在の条件を finally の後に残す |

### 13. [高] 拡張シャットダウンは 5 秒で待つのをやめ、未接続セッションは shutdown を出さない

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/harness.ts` `LIVE_SHUTDOWN_TIMEOUT_MS = 5_000` ~11265、`runExtensionShutdown` ~11356–11374。`backend/core/live-lifecycle.mjs` `disposeUnattachedSession` ~63–76 |
| 症状 | `Promise.race` が先に解けても `session_shutdown` の emit はキャンセルされない。続けて `disposeLive` が進み、MCP 子プロセスやソケットと破棄が競合する。コメントどおり、ensure が失敗した未接続セッションは shutdown を **意図的に出さない**（Goal Loop / intercom の共有状態を壊さないため）。失敗のたびに stdio サーバや SQLite が残る |
| 提案 | タイムアウト後は子プロセスを記録して打ち切る。未接続セッションは「共有マネージャに触らない資源」だけを個別に閉じる |

### 14. [高] `host.lock` は PID だけで、読めないロックは生存中でも消す

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/index.js` `acquireLock` ~979–1007。生存判定は `host/src/lock.js` `pidAlive` ~40–56（開始時刻なし） |
| 症状 | 死んだホストの PID が無関係なプロセスに再利用されると「Already running」のまま起動できない。逆に、`wx` 作成直後でまだ JSON が書き終わっていないロックは `readLock` が null になり、`existsSync` 分岐が **書いている最中の lock を削除**して第二ホストが claim できる。refresh lock 側は process start key を足した（`web/src/lib/codexbar/utils.ts`）が、ホスト単一起動には未適用 |
| 提案 | `{ pid, processKey }` を refresh lock と同じ規則で書く。未完成ファイルは「owner 不明なら削除しない、タイムアウトで閉じる」 |

### 15. [中] プロセス停止の生存判定が EPERM を死亡にし、負の PID でプロセスグループを殺す

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/process-stop.js` `stopProcessTreeGracefully` ~76–84、`signalProcessTree` ~28–33 |
| 症状 | `process.kill(pid, 0)` の例外はコードを見ず死亡扱い。権限だけで失敗すると「既に居ない」として soft/hard kill をスキップし、WebUI や llama が残る。POSIX では `kill(-pid)` がプロセスグループ全体に届く。PID 再利用後は別グループを巻き込みうる。`asPid` は自分自身と 1 以下だけを拒む |
| 提案 | ESRCH だけを死亡にする（`pidAlive` と揃える）。kill 前に開始キーが一致するときだけシグナルを送る |

### 16. [中] OAuth refresh lock の解放がパス一致だけで unlink する

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/codexbar/utils.ts` `withRefreshFileLock` ~357–362。奪取は ~302–315 で生存 owner を避ける |
| 症状 | 取得側は fail-closed で、PID 再利用も start key で見る。解放の `finally` は fd を閉じたあと **中身を比較せず** `unlinkSync(lockPath)`。奪取と解放が重なると、新しい持ち主のロックファイルを消して二本目の refresh が同じトークンを使える |
| 提案 | unlink 前に自分が書いた owner JSON であることを確認する。不一致なら触らない |

### 17. [中] `file-lock` の放棄判定が PID 再利用を生存のままにする

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/file-lock.mjs` `abandoned` ~8–17。AppStore の全 mutate が `withFileLock` を通る |
| 症状 | owner ファイルの PID が生きていれば、開始時刻が違っても放棄しない。Windows で PID が別プロセスに再利用されると、ストアロックが **そのプロセスが終わるまで**タイムアウトし続ける（既定 5 秒で失敗するが、リトライする操作は全部失敗する）。ディレクトリ側（#2）は逆に生きているロックを盗む |
| 提案 | refresh lock と同じく process start key。一致しない再利用は放棄してよい |

### 18. [中] ルーティン実行クレームは 2 時間で奪われ、終了時に無条件削除される

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/routines.ts` `ROUTINE_RUN_LOCK_STALE_MS` ~60–61、`tryClaimRoutineRun` ~169–184、`runRoutine` の `finally` ~252–254 |
| 症状 | Bot プロンプトが 2 時間を超えると別ワーカーが `.run.lock` を消して作り直す。先の実行が終わると `rmSync(claim)` が **新しい実行のクレームディレクトリ**を消す。同じルーティンが重なり、失敗回数や `lastRunAt` も交互に上書きされる |
| 提案 | クレームに owner を書き、解放は一致時だけ。長時間実行は heartbeat で mtime を更新する |

### 19. [中] hang-watch のロックは 30 秒でディレクトリごと消し、臨界区間が重なる

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/hang-watchdog.ts` `withWatchStoreLock` ~162–180 |
| 症状 | 解放は owner 一致のときだけなので、他人のロックを finally で消す事故は #2 より小さい。ただし stale 時の `rmSync(lock)` は **操作の途中**でもディレクトリを消す。二人とも `writeStore` に入り、後勝ちの rename が armed 行を失う。指紋計算で 30 秒を超えると起きうる |
| 提案 | stale 削除は owner のプロセスが死んでいるときだけ。操作中は heartbeat |

### 20. [中] スケジューラロックは決定ループが 30 秒を超えると盗まれる

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/routine-scheduler.mjs` `tryAcquireSchedulerLock` ~10–24、`runSchedulerTick` の `finally` ~73–75。`staleMs` は `routines.ts` ~59 の 30 秒 |
| 症状 | ロックは実行完了まで持たず「誰が due か」の間だけ、という設計。その間に `listBots` が遅いと第二プロセスがロックを消し、第一の `releaseLock` が第二のロックを消す。同じ分に同じルーティンが二度 claim される（#18 と重なると直列化が崩れる） |
| 提案 | owner トークン。due 判定が重いならロック内では id 列挙だけにする |

### 21. [低] SSE heartbeat の `setInterval` が abort 信号なしだと残る

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/sse-writer.ts` `startHeartbeat` ~84–88。片付けは enqueue 失敗か `signal` の abort ~107–115 |
| 症状 | ルートが `request.signal` を渡さない、またはクライアント切断が enqueue 例外にならない経路では、15 秒間隔のタイマーが閉じたコントローラに書き続ける。プロセスが Backend として長く生きるのでタイマーが積み上がる |
| 提案 | `startHeartbeat` した interval は `unref` しつつ、cancel コールバックを必ず登録する。signal 欠如は開発時に断言 |

### 22. [低] bots イベントハブは EventSource 生成失敗で再接続しない

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/bots-events-hub.ts` `openSource` ~100–107。対して `error` リスナー ~119–126 は backoff する |
| 症状 | コンストラクタが throw すると `return` するだけで `scheduleReconnect` しない。購読者は残るので、以降のイベント（未読・working）がタブ寿命のあいだ届かない。アイドルポールに依存する画面は間隔が伸びたままになる |
| 提案 | catch でも `scheduleReconnect` する |

### 第2巡で見たが優先度を上げなかったもの

- refresh lock の「タイムアウトしたらロック無しで refresh しない」は正しい（#16 は解放だけ）
- ルーティンの `lastRunAt` は完了後にしか更新されないが、クレームが無事なら二重起動は 409 になる（クレームが #18 で破れたときだけ問題）
- `runHangWatchdogTick` の `watchdogTicking` 重なり防止は入っている

---

## 第3巡（2026-10-04 Asia/Tokyo）— 空として読んだ設定を書き戻す

#1–#22 は再掲しない。本巡は「読めない＝空」のまま原子的に書き戻すストアと、UI が停止したと誤解する SSE。

| 項目 | 値 |
| --- | --- |
| HEAD | `aeeb43ee` |
| 本巡の新規 | **高 2 / 中 6 / 低 2**（合計 **10**；#23–#32） |
| 累計 | **高 9 / 中 17 / 低 6**（合計 **32**） |

### 23. [高] `accounts.json` の読取失敗が空一覧になり、次の更新で口座が消える

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/accounts.ts` `readAccountsFile` ~217–235、`writeAccountsFile` ~238–240、`withAccountsLock` ~248–255 |
| 症状 | #1 と同じ形。version 不一致やパース失敗は `{ version: 1, accounts: [] }`。ロックは「行の欠落」を防ぐためのもので、**空を正として書くこと**は止めない。資格情報ファイルは別に残っても、UI 上の口座とプロバイダー紐付けが消える |
| 提案 | 存在して読めないファイルへの write を拒否。peer-auth と同様に 500 |

### 24. [高] `relay.json` の読取失敗が空の envelope/claim になり、次 tick で単一使用トークンが消える

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/room-store.mjs` `readRelayState` ~101–112、`writeRelayState` ~124–141 |
| 症状 | コメントは「欠落・破損は空で、例外にしない」。リレー tick がその空オブジェクトを書き戻すと、消費済み claim と未消費 envelope が消える。同じ部屋配信が再実行されるか、逆に二度目の消費が通る |
| 提案 | 破損は空を書かず前回成功状態を維持。欠落ファイルだけ空を許す |

### 25. [中] 壊れた `settings.json` を `{}` としてエージェント上書きを保存する

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/agents.ts` `readSettings` ~98–104、`updateAgentOverride` ~366–394 |
| 症状 | パース失敗は空オブジェクト。ロック内でそれを読み、override を足して `atomicWrite` する。Pi の他設定（`settings.json` の未知キー）が、エージェントの有効/無効を一度変えただけで消える |
| 提案 | パース失敗時は上書きしない。ENOENT だけ空から作る |

### 26. [中] Backend の Goal Loop ファイル名が拡張の衝突回避名と違う

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/goal-loop-state.mjs` `stateFile` ~25–28（置換して 120 文字で切るだけ）。拡張は `extensions/leafcode-goal-loop/index.ts` `safeIdPart` ~285–292 と `goalStateFile` ~310–312（非 UUID は sha256 接尾辞） |
| 症状 | UUID はそのまま一致する。スラッシュや `?` を含むセッション id、または 120 文字超では、拡張が書くファイルとパネルが読むファイルが別になる。ループは走っているのに UI は停止、または古い legacy ファイルを見て誤った pause 判定をする |
| 提案 | `safeIdPart` を一箇所に寄せ、Backend はそれを使う。legacy 読取は拡張と同じ所有チェック付き |

### 27. [中] BotView の輸送エラーは再接続し続けるが、送信中フラグを下ろさない

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/bot/BotView.tsx` 名前付き `error` ~762–780（こちらは `closed = true` で再接続しない）、`onerror` ~782–787 |
| 症状 | プロキシの切断や 502 は `MessageEvent` ではないので `onerror` に入る。`setSending(false)` も `setError` も無い。バックオフは `sse-reconnect.ts` で最大 15 秒のまま無限。ユーザーには送信中のまま、サーバは次プロンプトを working 扱いで拒む、という分裂が続く |
| 提案 | 輸送エラーでも sending を下ろし、一定回数でエラー表示に切り替える。名前付き error と輸送 error で状態機械を共有する |

### 28. [中] Intercom の生存確認が一時エラーでもソケットを破棄する

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-intercom/broker/client.ts` `runLivenessProbe` ~125–143 |
| 症状 | `listSessions` の失敗はタイムアウトだけでなく、全部 `socket.destroy()`。ブローカが生きていて応答が遅いだけでも切断になり、`failPending` が飛行中の send を reject する。呼び出し側が再送すると、ブローカが既に受理したメッセージが二重投稿になる |
| 提案 | 破棄するのはタイムアウトと書き込み不能だけ。アプリケーションエラーはソケットを残す。再送は idempotency key |

### 29. [中] 部屋ロックが不正 ID だと無言でロックをスキップする

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/rooms.ts` `withRoomLock` ~54–56 |
| 症状 | `isValidId` でない id は `action()` を裸で実行する。コメントは「壊れたルート引数では欠落部屋の挙動を保つ」ため。将来、検証前にこのヘルパへ到達する経路があると、部屋 RMW が直列化されない。正規 UUID 以外のテスト用 id も同じ |
| 提案 | 不正 id は action せず undefined / 400。ロック省略はテスト専用の注入にする |

### 30. [中] ペイロードを書く前に死ぬと、空のリースファイルが最大 60 秒タスクを塞ぐ

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/task-runtime-lease.mjs` `acquireTaskLease` の `openSync(path, "wx")` ~161–165、`hasActiveTaskLease` ~194–196、`#isStalePath` ~101–105 |
| 症状 | 作成と本文書込の間にプロセスが死ぬと、`#readLease` は null。ファイル mtime が新しいあいだ `hasActiveTaskLease` は true、`#isStalePath` は false。取得は EEXIST のまま最大 4 回で false。作業中タスクはリース無しでも孤児回収まで `working` のまま、かつ新規取得もできない |
| 提案 | `wx` の直後に fsync した完全な JSON を書いてから「占有」とみなす。空ファイルは即座に reclaim してよい |

### 31. [低] 部屋イベントが `setMaxListeners(0)` でリークを隠す

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/rooms.ts` ~65 `roomEvents.setMaxListeners(0)` |
| 症状 | SSE 購読の解除漏れが警告されない。リスナーが増えると部屋更新のたびに古いクロージャが走り、閉じた応答へ書こうとして例外を握りつぶす。接続数の増加として不安定になる |
| 提案 | 上限は残し、購読解除をテストで数える |

### 32. [低] ストアの日次バックアップは当日の最初の 1 枚だけで、壊れた後の世代が無い

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/app-store.mjs` `#snapshotStore` ~65–75。`COPYFILE_EXCL` 失敗は return |
| 症状 | 朝の正常コピーのあと #1 の空上書きが起きても、その日のバックアップは朝のまま残る、という点は救いになる。逆に朝一発目が既に壊れたファイルだと、7 日分のローテーションがその壊れを「その日の正」として保持しうる。コピー失敗（ロック、ディスク満杯）は黙ってスキップ |
| 提案 | 書込成功後に世代を残す（日付だけでなく連番）。コピー失敗はメトリクス |

### 第3巡で見たが優先度を上げなかったもの

- `writeRelayState` の同一内容スキップ自体は妥当（空を書いたあとの被害は #24）
- 部屋 `createRoom` は新規 UUID でロック無しでも衝突しない
- Goal Loop の `safeIdPart` は拡張側では衝突を既に避けている（残差は #26 の Backend）

---

## 第4巡（2026-10-04 Asia/Tokyo）— プロセスの取り残しと二重所有者

#1–#32 は再掲しない。

| 項目 | 値 |
| --- | --- |
| HEAD | `aeeb43ee` |
| 本巡の新規 | **高 2 / 中 5 / 低 2**（合計 **9**；#33–#41） |
| 累計 | **高 11 / 中 22 / 低 8**（合計 **41**） |

### 33. [高] ランタイム所有者は環境変数だけで、二つのプロセスが同じデータディレクトリを実行できる

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/runtime-ownership.ts` `webOwnsRuntime` ~18–20（`NODE_ENV !== "production"` なら所有）、`localRuntimeBlocked` ~31–33。Host 側 `host/src/backend-service.js` ~7–9 と `shouldRunBackend` ~32–36 |
| 症状 | 開発 WebUI はセッションを開始し、Host が Backend も起動する組み合わせでは、両方とも正当な所有者になる。ファイルロックが運良く直列化しても、リース・ライブセッション・hang-watch はプロセスローカルのトークンなので **同じタスクを両方とも working にする**。ガードは「このプロセスの env」であり、ディスク上の単一所有者ではない |
| 提案 | データディレクトリに runtime owner ロック（host.lock と同型、start key 付き）を一つ。Backend と dev Web の同時所有を起動時に拒否 |

### 34. [高] 孤児タスク通知が 100 件を超えると古い分が捨てられ、自動再開に乗らない

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/task-runtime-lease.mjs` `MAX_PENDING_ORPHANS = 100` ~10、`reconcileOrphanedWorkingTasks` ~225–243 |
| 症状 | リスナー未登録のあいだに溜めたスナップショットは `slice(-100)`。101 件目以降の古い working タスクは status を error にしたあと、再開サービスへ渡らない。ユーザーからは「止まったまま、再開プロンプトも来ない」タスクが残る。リース喪失側も `MAX_PENDING_LEASE_LOSSES = 100` で同じ |
| 提案 | 上限で捨てず、ディスク上の error 行を再開側が自分で走査する（通知はヒントに留める） |

### 35. [中] Backend がクラッシュ再起動しても、残った孫プロセスを回収しない

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/backend-service.js` `exit` ハンドラ ~83–98。計画的停止は `process-stop.js` の `taskkill /T` があるが、この経路はプロセスが既に死んだあと `launch` するだけ |
| 症状 | Windows では Node が死んでも MCP stdio や翻訳子プロセスが残ることがある。新しい Backend が同じポート・同じ作業ディレクトリ・同じリースで起動し、古い子がファイルを掴んだままになる。再起動予算は 3 回で `failed` になり、そのときも残党は殺さない |
| 提案 | 起動前に「自分が起動した子の記録」またはコマンドライン一致の残党を回収する。予算切れでも回収はする |

### 36. [中] 翻訳サービスの停止がプロセス木ではなく直の子だけを kill する

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/translation-service.js` `stop` ~460–464。起動は ~480 の `spawn` |
| 症状 | `oldChild.kill()` は Windows ではその PID だけで、pip やモデルサーバの孫は残る。直後の `start` が同じスクリプトを起動するとポートやロックファイルが使用中のまま ready にならず、`state` は starting のまま再試行と衝突する |
| 提案 | `stopProcessTreeGracefully` を使う。exit を待ってから次の spawn |

### 37. [中] SSE `send` の `JSON.stringify` 例外が heartbeat を片付けない

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/sse-writer.ts` `send` ~68–73。`enqueue` は try するが stringify はしていない |
| 症状 | BigInt や循環がスナップショットに入ると throw がルートまで抜ける。`cleanup()` が呼ばれず interval が残る（#21）。ストリームはエラーで死ぬが、次の接続のたびにタイマーが増える |
| 提案 | stringify 失敗も `cleanup()` してからエラーイベントを一つ送る |

### 38. [中] リース奪取ロックの解放が無条件 `rmSync`

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/task-runtime-lease.mjs` `#reclaimStale` ~112–127、`#takeReclaimLock` ~131–141。`RECLAIM_LOCK_STALE_MS = 10_000` |
| 症状 | コメントは「数マイクロ秒」。10 秒を超えて掴まれると（ウイルス検査、ファイルシステム待ち）第二ワーカーが lock ディレクトリを消して入り、第一の `finally` が第二の lock を消す。その窓で二つの `wx` 作成が続き、コメントが防ごうとした「お互いの新リースを消す」が再び起きる |
| 提案 | reclaim ロックにも owner。10 秒ルールは死んだプロセスだけ |

### 39. [中] `host.log` のローテーションが他プロセスの追記と競合しうる

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/log-file.js` `rotateIfNeeded` ~44–62。コメント ~38–39 が他プロセス追記を認めている |
| 症状 | `rename(file, previous)` の直後に別プロセスが古いハンドルへ書くと、ローテーション済みファイルへ続き、新しい `host.log` は欠ける。障害調査のときに「落ちた直前の行が無い」。単一ホストなら同一スレッドなので実害は複数ライタのとき |
| 提案 | ログはホストプロセスだけが書く契約をコードで強制する。ローテーションは copytruncate ではなく、開いている fd を差し替える |

### 40. [低] AppStore キャッシュは mtime と size が同じだと本文を信用する

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/app-store.mjs` ~42–44 |
| 症状 | 同一サイズの書込が同一 `mtimeMs` に収まると、外部の修復やバックアップ復元を見逃す。次の mutate は古いメモリを書いて、復元した内容を再び壊す。NTFS では稀だが、コピーツールがタイムスタンプを保存すると起きる |
| 提案 | 可能なら inode/世代カウンタ。少なくとも起動時とロック取得時は raw を読み直す（ロック内の fresh は raw 比較なので、キャッシュ実体が汚れていなければ #10 の方が主問題） |

### 41. [低] Goal Loop の rename リトライがイベントループを同期的に止める

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-goal-loop/index.ts` ~704–708 `Atomics.wait`（最大おおよそ 45ms、コメントどおり） |
| 症状 | 性能というより、この待ちのあいだ abort タイマーとソケット処理が進まない。OneDrive がファイルを掴んだまま 3 回待ち、その後 #3 の直書きに落ちる。停止ボタンがその窓で遅れる |
| 提案 | 非同期リトライに移し、直書きフォールバックはしない（#3） |

### 第4巡で見たが優先度を上げなかったもの

- Backend 再起動予算が 60 秒生存でリセットされること自体は妥当
- `webOwnsRuntime` が production の WebUI をクライアントに固定している点は正しい。穴は dev との同時起動（#33）
- 翻訳 `stop` がリスナーを外してから kill する順序は、exit での再入を避ける意図で妥当。足りないのはプロセス木（#36）

---

## 第5巡（2026-10-04 Asia/Tokyo）— セッション破棄と配信の端

#1–#41 は再掲しない。

| 項目 | 値 |
| --- | --- |
| HEAD | `aeeb43ee` |
| 本巡の新規 | **高 2 / 中 5 / 低 2**（合計 **9**；#42–#50） |
| 累計 | **高 13 / 中 27 / 低 10**（合計 **50**） |

### 42. [高] アイドル破棄が `isStreaming` / `promptActive` / `isCompacting` を見ない

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/harness.ts` `isLiveEvictable` ~11294–11305、`evictIdleLiveSessions` ~11309–11321。間隔 `LIVE_REAPER_INTERVAL_MS = 5 分`、閾値 `LIVE_IDLE_EVICT_MS = 60 分` |
| 症状 | 除外はタスク status が working、リスナー、権限、質問、code relay、背景仕事だけ。ストアが idle のまま SDK がまだストリームしている（#12 で idle 化に失敗したあと、または status パッチだけ先に書かれたとき）と、`lastActivityAt` が 60 分更新されなければ `disposeLive` する。ツール実行中のセッションを足元から消す |
| 提案 | `session.isStreaming`・`isCompacting`・`promptActive` のいずれかなら破棄しない。#12 の finally とセットで直す |

### 43. [高] MCP stdio はリスナーの非同期作業を待たずに子を閉じる

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/mcp-native-stdio-transport.mjs` 先頭コメント ~64–67、`#stopDelivery` ~112–118、`close` ~129 |
| 症状 | 配信失敗で `emitClose` のあと `void this.close()`。コメントが「async listener work is not awaited/cancelled」「既に届いた効果は取り消さない」と書いている。ツールがまだ子プロセスで動いているのに切断され、ホスト側は失敗、子はファイルロックや部分書き込みを残す。セッション破棄（#13）と重なるとサーバプロセスが孤児になる |
| 提案 | close は in-flight の同期区間が終わってから。子はプロセスグループで打ち切る。部分成果はツール結果として明示的に失敗させる |

### 44. [中] ハング自動再開は最大 3 回だが、watch 行を空読みで失うと回数も消える

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/hang-watchdog.ts` `MAX_HANG_RETRIES = 3` ~35、`readStoreFile` が行をフィルタ ~128–138 |
| 症状 | #4 の空読みに加え、必須フィールドが一つ欠ける行は黙って落とす。`retryUsed` が無い行は「不正」として消え、次に arm されると回数 0 からやり直しになる。ハングしたプロンプトが 3 回で止まる契約が破れる |
| 提案 | 不正行は捨てずに isolating して残す。回数はタスク id 側の別ファイルに置く |

### 45. [中] ユーザー停止のあと Room メールボックス flush が失敗しても停止は成功扱いになりうる

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/abort-coordinator.mjs` ~55–62 とハング側 ~112–118 |
| 症状 | `setIdle` のあと `flushRoomMailbox` の例外は warn のみ。停止 API は成功を返すが、部屋 Bot のキューが残る。次のターンが「停止したはずのプロンプト」を拾って投稿する。flush がロック待ちで throw する（#2 の busy）と顕在化 |
| 提案 | flush 失敗は停止応答に含め、再 flush を durable キューに残す。成功とみなして 200 だけ返さない |

### 46. [中] pending なユーザー判断は先頭以外にも即タイマーが付き、衝突 id はタイムアウト値で黙って解決する

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/pending-prompts.mjs` `handleRequest` ~66–90、`armTimer` ~42–48。タイムアウト 5 分 |
| 症状 | 同じ request id が別セッションから来ると、新しい側は `timeoutValue` で即 resolve し、UI には出さない（~76–78）。権限や質問が「ユーザーが拒否した」のか「id 衝突で捨てた」のか区別がない。ツールは拒否として進み、監査ログも残らない |
| 提案 | 衝突は明示エラーでツールを失敗させる。タイムアウト値を流用しない |

### 47. [中] Goal Loop の temp 復旧が、セッション id の一致しない temp を本ファイルへ昇格しうる

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-goal-loop/index.ts` `recoverLoopFromTemp` ~554–591。`requireSessionIdMatch` は legacy 経路 ~636 だけ true |
| 症状 | 通常の `readLoop` は `requireSessionIdMatch` 既定 false。temp 内の `sessionId` が別でも、hydrate が成功すれば `renameGoalState` で **今読んでいる id の本ファイル**にする。ファイル名が共有される legacy 名（#26）と組み合わさると、別セッションのゴールで上書きされる |
| 提案 | 昇格前に `record.sessionId === id` を必須にする。不明な古い temp は隔離ディレクトリへ移す |

### 48. [中] 翻訳子プロセスの stdout が JSON でない行を永久に無視し、ready 前のハングを自分で切らない

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/translation-service.js` ~488–496。`start` は ready を Promise で待つ ~476–479 |
| 症状 | Python がトレースバックを出して exit しない（デッドロック、入力待ち）と `state === "starting"` のまま。次の `start` は readyPromise を返すだけで第二の監視を作らない。呼び出し元の翻訳は ready 待ちで積み、Host のイベントループにはタイマーが無いので **オペレータが再起動するまで戻らない** |
| 提案 | ready までの壁時計タイムアウト。超過したら #36 のプロセス木停止 |

### 49. [低] Bot 一覧は壊れた config をスキップするだけで、移行書込の失敗は「Bot が居ない」になる

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/bot-config.mjs` ~135 `catch { return null }`、`bot-store.mjs` `listConfigs` ~56–63 |
| 症状 | #7 の書き戻しが EPERM で throw すると、parse 全体が null。有効な Bot が一覧から消え、ルームのメンバー解決が「不明な Bot」になる。ディスク上の config は残っているので、次回読めた瞬間に復活する。その間にメンバー編集を保存すると `assertKnownRoomMembers` が欠落扱いにする |
| 提案 | 移行書込の失敗は読めた config を返し、dirty フラグだけ立てる。一覧から落とさない |

### 50. [低] Host の 5 秒間隔メンテが失敗を空の catch で捨てる

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/index.js` ~1308–1311 `reconcileWebUiBinding` は `void`、`refreshStatusMenu().catch(() => {})` |
| 症状 | トレイの状態と実プロセスの対応がずれてもログが残らない。ユーザーは「動いている」メニューのまま、WebUI は落ちている、を再起動まで気づかない。安定性の観測点が無い |
| 提案 | 失敗はホストログへ rate-limit して出す。連続失敗でトレイ項目を degraded にする |

### 第5巡で見たが優先度を上げなかったもの

- `evictIdleLiveSessions` は shutdown 後にもう一度 evictable か見る（置換レースへの対処は入っている）。不足はストリーム中の判定（#42）
- bots ハブの `error` 後 backoff は実装されている（穴はコンストラクタ失敗 #22）
- `disposeUnattachedSession` のコメントは既知リークを認めている（#13 に含めた）
- pending prompt の「決定済み id は再利用可」は意図どおり

## 第6巡（Goal Loop中心）（2026-10-04 Asia/Tokyo）

第1–5巡 #1–#50 は再掲しない。とくに #3（非原子 rename と temp 全削除）、#26（Backend 側ファイル名）、#41（Atomics.wait）、#42（ストリーム中のアイドル破棄）、#47（temp の sessionId）は繰り返さない。本巡は Goal Loop のスケジューラ、ホスト再起動、ハング watchdog、ミッション workflow-state、リース付きターン準備の相互作用だけ。

| 項目 | 値 |
| --- | --- |
| HEAD | `28f55360`（`28f553600fdb7897ebe4123fe1370e21cea6fd6d`） |
| 本巡の新規 | **高 3 / 中 5 / 低 2**（合計 **10**；#51–#60） |
| 累計 | **高 16 / 中 32 / 低 12**（合計 **60**） |

### 推奨着手順（第6巡分）

1. **#51** アイドル破棄の対象から live な Goal Loop（queued / running / verifying）を外す
2. **#52** ハング停止とタスク Stop を、Goal Loop の「内部 abort → 自動 requeue」から区別する
3. **#53** 再起動拒否をディスク上の live status も含める（live map だけにしない）

### 51. [高] クールダウン中の Goal Loop が 60 分でアイドル破棄され、一時停止になる

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/harness.ts` `isLiveEvictable` ~11294–11305（`LIVE_IDLE_EVICT_MS = 60 分`）。破棄は `emitLiveSessionShutdown` のあと。Goal Loop 側 `extensions/leafcode-goal-loop/index.ts` `session_shutdown` ~2780–2810。クールダウン上限は `MAX_COOLDOWN_SECONDS`（24 時間）~107 |
| 症状 | ターン間はタスク status が working でないことが多い。queued / verifying_completed で `nextTurnAt` を待っているだけだと、リスナーが無く 60 分触らないセッションは破棄される。shutdown の reason は reload ではないので、queued も paused に書き換わる。24 時間クールダウンのループが、ユーザーの停止なしに止まる。#42 はストリーム中の破棄で、クールダウン待ちは別 |
| 提案 | `isGoalLoopLiveStatus` のセッションは破棄しない。破棄するなら shutdown 前に pause 理由を `idle_evict` と書き、自動再開と区別する |

### 52. [高] ハング watchdog が「再開しない」で止めても、Goal Loop が数秒で同じターンを再送する

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/hang-watchdog.ts` `resolveHang` ~524–528（`skipResume` は disarm して return）。Goal Loop `settleAwaitingTurn` ~1336–1344 が abort を `pauseLoop(..., "user", ABORTED_TURN_PAUSE_ERROR)` にし、結果が無ければ `requeueInterruptedTurn` ~1534–1561。保険の `ensureScheduled` ~1705–1711 も同じ再キューを 5 秒間隔で行う |
| 症状 | ハング停止はチャットへのプロンプト再注入を避ける契約。Goal Loop は SDK abort を「内部中断」とみなし、cooldown 後に同じターン番号をキューへ戻す。ユーザーから見ると止めたターンが勝手に再開し、リースと working が再び取られる。タスクの Stop ボタンも同じ abort 経路なら、`/goal-stop` 以外ではループが終わらない |
| 提案 | skipResume の abort とユーザーの Stop は `pauseReason` を `hang` / `user` にし、`requeueInterruptedTurn` の対象から外す。自動再送は turn_timeout だけに限る |

### 53. [高] 再起動ガードはメモリ上の live セッションだけを見て、ディスクのループを見逃す

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/harness.ts` `activeGoalLoopTaskIds` ~8019–8029（`isLiveGoalLoopSession`、catch は false）。Host の Backend 拒否は `host/src/runtime-restart-guard.js` ~26–28。Web ルート `web/src/app/api/goal-loop/active/route.ts` ~18–19。生産 Host は `host/src/index.js` `webUiRestartBlockReason` ~661–663 で Backend があると Goal Loop を見ずに Web 再起動を許す |
| 症状 | ガードのコメントは「死んだワーカーの running ファイルで再起動を永久に拒まない」ため。逆に、shutdown の `writeLoop` が失敗した running / queued（~2808–2809）、または live map にまだ載っていないループは件数が 0 になる。再起動や SIGKILL のあと session_start は queued を **自動 schedule** する（~2582–2584）。running だけは手動 resume を要求する。同じクラッシュでも状態によって勝手に再開するか、止まったままかが割れる |
| 提案 | 再起動前はデータディレクトリの goals-loop を走査し、queued / running / verifying_completed が残っていれば拒否するか、起動時に必ず lifecycle pause を書いてからプロセスを落とす。Web 再起動は Backend 所有でもその結果を表示する |

### 54. [中] スケジューラ watchdog が、まだ終わり切っていない running を queued に降格する

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-goal-loop/index.ts` `ensureScheduled` ~1715–1724。間隔 `SCHEDULE_WATCHDOG_MS = 5_000` ~130。`schedule` は `isIdle` でないと 500ms で再武装 ~1648–1650 |
| 症状 | 「settlement が来なかった」回復として、idle かつ running なら status を queued または verifying_completed に書いて `schedule` する。ハング abort の `waitForIdle` の直前や、ツールが isIdle を真にした瞬間にこれが走ると、ディスクは queued、SDK はまだ前ターン、のあと sendTurn が次ターンを足す。turnCount が二重に進むか、同じ作業が並行する |
| 提案 | running → queued の降格は、セッションが idle になってから一定時間（ターンタイムアウトと同程度）待ってから。その間に agent_settled が来たら降格しない |

### 55. [中] ミッション workflow-state は起動キーの照会に失敗すると、生きているロックを奪う

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-subagents/src/missions/workflow-state.ts` `stateLockIsStale` ~150–165。コメント ~159–160 は「照会失敗では奪わない」。実装は `if (!currentProcessKey) return true`。processKey が無い owner も 60 秒後に `return true` ~164–165。Goal Loop のターンから mission の `state.set` がこのロックを取る（~313–317） |
| 症状 | Windows の PowerShell が 1 秒でタイムアウトすると、PID が生きていても stale になる。`reclaimStaleStateLock` がディレクトリを消し、もう一方が `state.json` を書く。Goal Loop が長いターンの途中でミッション状態を更新していると、進捗キーが欠ける。コメントの意図と逆 |
| 提案 | 照会失敗は stale にしない（PID が生きている間は保持）。processKey 無しの現行ロックも、PID 生存中は奪わない |

### 56. [中] workflow の `get` は一度読むと他プロセスの `set` を見ない

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-subagents/src/missions/workflow-state.ts` `load` ~296–300、`get` ~305–308。`set` はロック下で読み直す ~313–314 |
| 症状 | `loaded` が真のあいだ `get` はメモリだけを返す。Goal Loop がサブエージェントにミッションを渡すと、別プロセスが `set` した値を親の `get` が古いコピーのまま見る。分岐条件が古く、ループは進んだつもりで同じ工程を繰り返すか、完了した工程を未完了として再開する |
| 提案 | `get` もロック下でディスクを読む。または世代 mtime が変わったらキャッシュを捨てる |

### 57. [中] ターンタイマーとスケジュールタイマーが unref で、プロセス終了時に pause を書けない

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-goal-loop/index.ts` `armTurnTimeout` ~769–770、`schedule` ~1677、`startScheduleWatchdog` ~1729–1730。いずれも `unref` |
| 症状 | HTTP サーバが閉じたあとに残るのはこのタイマーだけ、という終了順だと、クールダウンも 15 分の無進捗停止も発火しない。`session_shutdown` が走る前にイベントループが空になり、ディスクは queued または running のまま残る。次の起動は #53 のとおり状態によって自動再開する |
| 提案 | ループが live status のあいだはタイマーを ref する。終了処理では unref する前に lifecycle pause を同期的に書く |

### 58. [中] `prepareGoalLoopTurn` が stranded な working を idle に戻すときリースを外さない

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/harness.ts` ~3295–3308。直前の `releaseIdleReservation` ~3273–3282 は status が working でないときだけリースを放す |
| 症状 | 送信前に落ちるとタスクは working、ループは queued、リースは自プロセスのまま、という回復をここで idle にする。`releaseTaskLease` は呼ばれない。自プロセスが生きている間は次の prepare が自分のリースを使えるので動く。プロセスがリースを持ったまま heartbeat に失敗する（#9）と、他ワーカーからは active、この回復を通った UI からは idle で、Goal Loop の次ターンが 409 になる |
| 提案 | idle へ戻すなら同じブロックで、トークンが自分のときだけリースを解放する |

### 59. [低] 壊れた `nextTurnAt` は待ちを飛ばしてすぐに sendTurn する

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-goal-loop/index.ts` `schedule` ~1641–1646。`MAX_TIMER_DELAY_MS` で 2^31-1 はクランプ済み ~123–124 |
| 症状 | `Date.parse` が NaN のとき「まだ先」の分岐に入らない。queued のまま即送信になる。手編集や途中書き込み（#3）で nextTurnAt が欠けると、クールダウンを無視してターンが進む。上限 24 時間はクランプの内側なので、正常値では 1ms スピンにはならない |
| 提案 | 数値でない nextTurnAt は pause（scheduler_error）にする。即送信しない |

### 60. [低] ライフサイクル pause の pauseReason が空で、オペレータ停止と区別できない

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-goal-loop/index.ts` session_start ~2569–2571、session_shutdown ~2801–2805。`pauseReason = ""`。Backend の operator hold は `backend/core/goal-loop-state.mjs` の `user` と `manual_send` だけ |
| 症状 | セッション切断の一時停止は paused なので再起動の自動再開（restart-resume）は所有中として避ける。一方 UI と `isOperatorHold` は理由が空だと「ユーザーが止めた」のか「クラッシュで止まった」のか分からない。Resume を押すまで queued に戻らず、空理由のまま放置されるループが増える |
| 提案 | `pauseReason` を `session_end` のように専用値にする。パネルはそのときだけ「再接続後に resume」と出す |

### 第6巡で見たが優先度を上げなかったもの

- rename の直書きと temp 掃引（#3）、Atomics.wait（#41）、Backend の legacy ファイル名（#26）
- `MAX_TIMER_DELAY_MS` 自体は Node の 1ms クランプ対策として正しい
- reload 時に queued を pause しないのは、後継 session_start が schedule する前提。失敗時の穴は #53 / #57
- 生産 Host が WebUI 再起動で Goal Loop を見ないのは、セッション所有者が Backend である限り正しい。死角は Backend 側の一覧（#53）

## 変更していないもの

- 製品ソース・テスト
- `OPTIMIZATION-AUDIT-2026-10-04.md`
- `BUGS-PERF-AUDIT-2026-10-03.md`
- `PI-MCP-CODEMODE-AUDIT-2026-10-04.md`
- 第1–5巡の本文（#1–#50）
