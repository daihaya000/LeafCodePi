# LeafCodePi 最適化余地メモ（2026-10-04）

読み取り専用スキャン。製品ソースは未変更。バグ監査（`BUGS-PERF-AUDIT-2026-10-03.md`）／Pi MCP・codemode 監査（`PI-MCP-CODEMODE-AUDIT-2026-10-04.md`）と重なるホットスポットは「既存監査と重複」と明記し、本メモは **CPU・同期 I/O・ポーリング・SSE・キャッシュ・メモリ・MCP/codemode コスト** の最適化観点を優先する。

| 項目 | 値 |
| --- | --- |
| 日付 | 2026-10-04（Asia/Tokyo） |
| HEAD | `6ec2037183279e145ef63f7a5b295816d9785113`（`6ec20371`；第1–5巡スキャン。第1 `0e3aa5f8` / 第2 `6651537d` / 第3–5 同 HEAD） |
| リポジトリ | `C:/Users/Daichi/Desktop/LeafCodePi`（X870） |
| 件数 | **高 18 / 中 32 / 低 18**（合計 **68**；第1–4巡56 + 第5巡12） |
| 方針 | 観測可能なコスト削減案。セキュリティ修正は別 MD |

## 優先度サマリ

| 優先 | 件数 | 狙い |
| --- | --- | --- |
| **P1 高** | 18 | 上記＋hang fingerprint SHA・bundle 全文 hash・project-agent 250ms ポール |
| **P2 中** | 32 | 上記＋Intercom name ポール、partial 出力 Map、pretty JSON 書込、file-lock スピン、添付 base64、Llama 設定ポール |
| **P3 低** | 18 | 上記＋git-pull 同期、完了音 AudioContext、engine 停止時 health ポール |

## 推奨着手順

1. **P1-1** BotView 裏ペイン SSE（未読要件と両立する最小ガード）
2. **P1-2** Watchdog `change-signature` の同期 git + 大容量 hash を非同期化／差分化
3. **P1-3** `AppStore.#readStore` の二重 `JSON.stringify` をやめる
4. **P1-4〜6** MCP/codemode の宣言肥大・巨大 structuredContent・progress×timeout
5. **P1-21〜23**（第2巡）CodeRequest フルポール、経過クロック 250ms、relay 2s tick
6. **P2** 翻訳 debounce、worktree/Graph/Code/subagent ポール、sysmon/browse、Markdown
7. **P3** 残余の計測と微調整

---

## P1 — 高インパクト（第1巡 #1–6）

### 1. BotView が `active=false` でも EventSource を張り続ける

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/bot/BotView.tsx`（SSE effect ~623–796、deps `[cachedSession, id, sseEpoch]`） |
| コスト | 分割タブの裏ペインごとに常時 SSE + 15s heartbeat（Backend `runtime-events.mjs`）+ 再接続。N タブで接続 N 本 |
| 既存監査と重複 | BUGS-PERF P5「BotView は未読・streaming・Code request のためガードしない」一部修正済み方針。**最適化余地は残る** |
| 案 | 裏ペインは `task_dirty` / bots hub のみ購読し、前面化でフル SSE。または `document.visibilityState` + `active` でスロットル。未読バッジだけ軽量ポーリングに分離 |
| 効果見込み | 裏タブ 3〜5 本で Backend/BFF の常時接続と JSON snapshot 処理が比例減 |

### 2. Watchdog 変更署名が同期 `git` + 最大 64MB×2000 エントリ hash

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-subagents/src/watchdog/change-signature.ts`（`git`/`spawnSync`、`hashFile`=`readFileSync`、予算 64MiB/ファイル・合計・2000 entries） |
| コスト | `rev-parse` + `status --porcelain -z`（maxBuffer 10MB）のあと、変更パスごとに **同期** hash。ネスト worktree はさらに `status`+`rev-parse`。edit/write ターン末でイベントループを秒単位止めうる |
| 既存監査と重複 | なし（本メモ新規） |
| 案 | `spawn` 非同期化、mtime+size 先行比較で hash 省略、前回 signature との差分パスのみ再 hash、予算既定を下げ計測可能なメトリクスを出す |
| 効果見込み | 大規模 dirty tree で UI/エージェント応答のスパイク消失 |

### 3. `AppStore.#readStore` が同一内容でも二重 `JSON.stringify` 比較

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/app-store.mjs` ~51–54 |
| コスト | mtime/size が変わったが内容が同じとき、`JSON.stringify(cached) === JSON.stringify(parsed)` でストア全体を **2回** 直列化。プロジェクト/タスクが増えると毎回 O(ストアサイズ) CPU |
| 既存監査と重複 | なし（本メモ新規。キャッシュ自体は健全） |
| 案 | 内容同一性は厳密比較をやめ、パース結果でキャッシュ差し替えのみ。必要なら xxhash 等の短いダイジェスト |
| 効果見込み | 外部 touch やバックアップ復元後のホットパスで stringify コストをほぼゼロに |

### 4. MCP `tool_search` が codemode 既定ツールをモデル宣言へ昇格

| 項目 | 内容 |
| --- | --- |
| 場所 | Pi MCP / LCP harness（`tool_search` × `exposure` 既定 `codemode`） |
| コスト | モデルコンテキストに `mcp__*` が増え、毎ターンのプロンプトトークン・ツールスキーマ送信が増大 |
| 既存監査と重複 | PI-MCP §8.1（高） |
| 案 | codemode 既定は search 結果でも宣言に載せない／明示 `exposure:"direct"` のみ昇格 |
| 効果見込み | MCP サーバが多いセッションで入力トークンとレイテンシ削減 |

### 5. codemode / MCP 結果の巨大 `structuredContent` が VM・メモリを圧迫

| 項目 | 内容 |
| --- | --- |
| 場所 | MCP `limitMcpContent` は最終テキスト中心；codemode 向け structured は非 truncate（PI-MCP 記載） |
| コスト | 巨大 JSON を QuickJS / ホスト側に載せると GC とコピーコストが跳ねる |
| 既存監査と重複 | PI-MCP §8.8 付近（低〜中のコスト面） |
| 案 | structuredContent にもバイト上限＋参照パス化（フルはファイルへ） |
| 効果見込み | 異常に大きい MCP 応答時の OOM・ハング回避 |

### 6. MCP progress がタイムアウトを都度リセット（実質無制限実行）

| 項目 | 内容 |
| --- | --- |
| 場所 | Pi MCP client（progress → timeout 振り直し） |
| コスト | 長時間ツールが CPU/接続/子プロセスを占有し続け、他セッションのスループットを落とす |
| 既存監査と重複 | PI-MCP §7.2 |
| 案 | 絶対 deadline と idle timeout を分離 |
| 効果見込み | 暴走ツールの資源占有上限が明確化 |

---

## P2 — 中インパクト（第1巡 #7–14）

### 7. TaskView worktree 件数ポーリングが 4 秒ごと（前面・可視時）

| 項目 | 内容 |
| --- | --- |
| 場所 | `TaskView.tsx` ~1956–2000 → `GET /api/diff/files?count=1` → `status --porcelain` + `symbolic-ref` |
| コスト | count モードでも **git 2 本/回**。前面タブ×可視で 15 回/分。複数タスクペインがあると乗算 |
| 既存監査と重複 | count モード導入は BUGS-PERF 周辺の改善済み。**間隔・トリガは未最適化** |
| 案 | `working` 中は止める／`webui:tasks-changed` と file watch のみ／間隔を 10–15s に／Backend dirty 連動 |
| 効果見込み | アイドル UI の git 負荷を半減以上 |

### 8. 翻訳 `saveCache()` がヒットのたび全エントリ sort + 全量 stringify + 秘密ファイル書込

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/translation-service.js` `saveCache` ~214–238 |
| コスト | `CACHE_MAX_BYTES` まで trim するたびに `JSON.stringify` を繰り返し。推理ストリーム中の連続翻訳でディスク I/O が連打 |
| 既存監査と重複 | なし（本メモ新規） |
| 案 | debounce（例: 2–5s）または dirty フラグ＋プロセス終了/アイドル時 flush |
| 効果見込み | 連続翻訳時の Host ディスク・CPU スパイク低減 |

### 9. Host Windows の PID/起動キー確認が同期 PowerShell

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/index.js` ~263–305、`llama-server-service.js` WMI、`atomic-lock-coordinator.ts`、subagents workflow-state |
| コスト | Windows で powershell 起動は数百 ms〜1s |
| 既存監査と重複 | BUGS-PERF（TTL メモ化で一部改善済み）。**Host 本体の都度 spawn は残る** |
| 案 | 常駐ヘルパ、または Node native 照会＋Host 側 TTL 共有 |
| 効果見込み | Host 操作の体感応答改善 |

### 10. `/api/health` の TTL 切れ時 `listModels()` が ~250ms

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/harness.ts` ~5343–5354（HEALTH_TTL 15s、SWR あり） |
| コスト | 切れ目だけ llama/Ollama 同期が乗ると BFF が短時間ブロック |
| 既存監査と重複 | コメント上の既知コスト |
| 案 | inflight 共有の監査、provider 別 TTL、health から models 同期を完全分離 |
| 効果見込み | ポーリングピーク時のテールレイテンシ改善 |

### 11. llama models 一覧の同期 `readdirSync`（TTL あり）

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/app/api/llama-server/models/route.ts`（上限 20000、mtime+5s TTL） |
| 既存監査と重複 | BUGS-PERF P5 一部修正済み |
| 案 | 非同期 `fs.promises`、UI はキャッシュ優先 |
| 効果見込み | 初回/TTL 切れの BFF ブロック短縮 |

### 12. `chat-progress` / worktree 隔離の同期 `git` spawn

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-subagents/src/workflows/chat-progress.ts`、`runs/shared/worktree.ts` |
| 既存監査と重複 | chat-progress は rev-parse まとめ＋30s TTL で一部改善 |
| 案 | worktree 作成パスも非同期 git、identity キャッシュの共有モジュール化 |
| 効果見込み | ワークフロー開始時のブロッキング短縮 |

### 13. Goal Loop 状態保存の同期 rename 残余ブロッキング

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-goal-loop/index.ts`（Atomics.wait 化済み、実測 ~39ms） |
| 既存監査と重複 | BUGS-PERF P5 |
| 案 | 完全非同期化は構造変更が必要。現状は許容コストとして計測継続 |
| 効果見込み | さらなる削減は小さい |

### 14. Native MCP `!command` 解決が `spawnSync` + `shell:true`（最大 10s）

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/src/mcp-native-activation.mjs` `runEnvCommand` |
| コスト | サーバ数×起動時に直列で最大 10s |
| 既存監査と重複 | PI-MCP（セキュリティ中）。**最適化は並列化・キャッシュ・非同期** |
| 案 | 短 TTL キャッシュ、上限付き並列、async spawn |
| 効果見込み | MCP 多数時の Backend 起動短縮 |

---

## P3 — 低インパクト（第1巡 #15–20）

### 15. CodexBar 5分ポーリング + 1分 clock

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/codexbar/use-codex-usage.ts` |
| 評価 | visibility / stale / inflight 済みで良好 |

### 16. GlobalAttention / Sidebar の dirty 連動ポーリング

| 項目 | 内容 |
| --- | --- |
| 場所 | `GlobalAttentionProvider.tsx`（4s → dirty 時 15s）、`Sidebar.tsx`（4s/12s/20s） |
| 評価 | 既に最適化済み。dirty 未接続時のみ 4s が残る |

### 17. TaskView スクロール追従の `setInterval(200)` フォールバック

| 項目 | 内容 |
| --- | --- |
| 場所 | `TaskView.tsx` ~1854–1861（`ResizeObserver` 無い環境のみ） |

### 18. Runtime SSE heartbeat 15s / live reaper 5min

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/src/runtime-events.mjs`、`harness.ts` `LIVE_REAPER_INTERVAL_MS` |

### 19. プロファイル取り込みの `arrayBuffer()` 一括読み

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/app/api/profile/route.ts` |
| 既存監査と重複 | BUGS-PERF |

### 20. `scripts/web-build-mirror.mjs` の size+mtime 一致時フルバイト比較

| 項目 | 内容 |
| --- | --- |
| 既存監査と重複 | BUGS-PERF 見送り（意図的設計） |

---

## 第2巡（2026-10-04 Asia/Tokyo）— 追加最適化余地

第1巡の 20 件は再掲しない。焦点: **ポーリング / SSE 周辺 UI / sync spawn・PowerShell / harness Map・キャッシュ / メモリ / 再描画 / build / sysmon / browse / relay**。

| 第2巡のみ | 件数 |
| --- | --- |
| 高 | 3 |
| 中 | 6 |
| 低 | 3 |
| 小計 | **12** |
| 累計 | **32**（高9 / 中14 / 低9） |
| スキャン HEAD | `6651537d` |

### 推奨着手順（第2巡分）

1. **#21** CodeRequestCard の 2 秒フル TaskDetail ポーリングを軽量エンドポイント／SSE に
2. **#22** 共有経過クロック 250ms の再描画範囲を縮める
3. **#23** Bot Code relay tick を dirty/outbox stamp 連動へ
4. **#24–26** Graph / Code パネル / subagent の固定間隔ポーリングをイベント駆動化
5. **#27–30** sysmon 冷スタート・browse PowerShell・Markdown ストリーム再パース・offline snapshot
6. **#31–33** build walk・sysmon visibility・FIFO キャッシュ微調整

### 21. [高] CodeRequestCard が live 中 2 秒ごとにフル `TaskDetail` を GET

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/bot/CodeRequestCard.tsx` ~90–116（`setInterval` 2_000 → `GET /api/tasks/:id`） |
| コスト | カード表示中、メッセージ全文付き detail を 30 回/分。複数カードで乗算。BFF+harness のセッション読取が支配的 |
| 既存監査と重複 | なし（BotView SSE 常時接続とは別経路） |
| 案 | 進捗専用の薄い API（status / todo / goalLoop のみ）または既存 task SSE。非 live は既に停止済み |
| 効果見込み | Code 依頼 UI 表示中の BFF CPU・帯域を大幅削減 |

### 22. [高] ツール経過表示の共有クロックが 250ms で全リスナー再描画

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/ui.tsx` `SHARED_ELAPSED_CLOCK_MS = 250`、`useToolElapsedMs` → 各 `ToolCard` |
| コスト | 実行中ツール N 個で **4 Hz × N** の React setState。ストリーミング Markdown と重なるとメインスレッドが忙しなくなる |
| 既存監査と重複 | なし（interval 共有化は済、**頻度が高い**） |
| 案 | 1000ms に落とす、`document.hidden` で停止、経過ラベルを独立 memo |
| 効果見込み | 長時間ツール実行中の UI フレーム落ち緩和 |

### 23. [高] Bot Code relay が常時 2 秒 `setInterval` で outbox スキャン

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/bot-code-request.mjs` `CODE_RELAY_TICK_MS = 2_000`、`web/src/lib/pi/bot-code-relay.ts` ~1389 |
| コスト | アイドルでも 2s ごとに tick（listing TTL 1s・レコードキャッシュありでもタイマー発火と stamp 検査は走る） |
| 既存監査と重複 | なし（キャッシュ自体は最適化済み。**間隔が残課題**） |
| 案 | outbox 書込時に即 tick、通常 5–15s、`fs.watch`（debounce）併用 |
| 効果見込み | アイドル時 Host/Web のバックグラウンド CPU 低減 |

### 24. [中] GraphPanel が working 中 4 秒ごとに `git log` + refs

| 項目 | 内容 |
| --- | --- |
| 場所 | `GraphPanel.tsx` `POLL_ACTIVE_MS=4000` / `POLL_IDLE_MS=15000`、`GET /api/git/log` → `gitLogGraph` + `gitBranchRefs` |
| コスト | 前面グラフ表示かつ working で 15 回/分。`limit` はロード済み件数まで増え重い。payload 同一性ガードは済 |
| 既存監査と重複 | TaskView worktree 4s（#7）とは別 API |
| 案 | HEAD `rev-parse` 短絡、working でも 8–10s、コミット系イベントだけで即 refresh |
| 効果見込み | 大きな履歴リポで git サブプロセス負荷減 |

### 25. [中] BotCodeSessionPanel が live 中 2 秒ポール

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/bot/BotCodeSessionPanel.tsx` ~104–121 |
| コスト | Code パネル表示かつ working/goal-loop live で 2s ごと `load()` |
| 案 | `notifyBotSidebarChanged` / bots-events hub 連動、間隔 5s |
| 効果見込み | Code パネル開放時の API 半減以上 |

### 26. [中] `use-subagent-runs` が live 中 2 秒ポール

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/task/use-subagent-runs.ts` `POLL_MS = 2000` |
| コスト | サブエージェント進捗 UI 表示中に固定 2s。Task SSE と独立 |
| 案 | task_dirty / 親 SSE で起こし、安全網は 5–10s |
| 効果見込み | サブエージェント多数時の一覧 API 削減 |

### 27. [中] sysmon の Windows プローブがキャッシュミスで PowerShell `Add-Type`（秒単位）

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/sysmon-usage.ts`（USAGE_CACHE 既定 3s、温度 30s）、UI `SYSMON_POLL_ACTIVE_MS=15s` / collapsed 60s |
| コスト | コメントどおり Add-Type コンパイルがミス時に数秒。TTL 切れ・初回で BFF を塞ぐ |
| 既存監査と重複 | なし（Host の他 PowerShell 項目とは別） |
| 案 | 常駐ヘルパ／プリコンパイル、ワーカー間共有キャッシュ、温度・GPU を分離エンドポイントに |
| 効果見込み | sysmon 初回・TTL 切れのテールレイテンシ改善 |

### 28. [中] browse `/api/browse/dirs` が毎回 drives+quickAccess を待ち合わせ（Windows は PowerShell）

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/app/api/browse/dirs/route.ts`、`web/src/lib/browse-drives.ts`（各 10s TTL）、symlink は `statSync` 判定 |
| コスト | フォルダ移動のたび Promise.all。TTL 切れで PowerShell 2 本。巨大 dir の symlink は同期 stat |
| 既存監査と重複 | なし |
| 案 | クライアント側セッションキャッシュでクエリ省略、symlink 判定は非同期バッチ |
| 効果見込み | プロジェクト追加ダイアログのクリック応答改善 |

### 29. [中] ストリーミング中 `MarkdownBody` が全文を毎更新再パース

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/task/PartView.tsx` `MarkdownBody`（`react-markdown` + `remarkGfm`） |
| コスト | トークン毎に GFM 再パース。#22 と複合すると顕著 |
| 既存監査と重複 | なし |
| 案 | ストリーム中はプレーン／簡易、完了後だけ Markdown。または 100–200ms debounce |
| 効果見込み | 長文ストリーム時のスクロール・入力遅延緩和 |

### 30. [中] offline session snapshot は最大 8×2MiB だがミス時に `SessionManager.open` 全読

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/harness.ts` `offlineSessionSnapshots` ~7515–7575 |
| コスト | FIFO 8 件。ミス／追い出しで重いパースが remote poll・アーカイブ表示に乗る |
| 既存監査と重複 | なし（`todoProgressCache` 2048 とは別） |
| 案 | LRU、軽量サマリと全文分離、2MiB 超はページ単位 |
| 効果見込み | 古いタスク横断表示のスパイク抑制 |

### 31. [低] Host `web-plan.js` のビルド鮮度判定が同期ツリー walk

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/web-plan.js` `readdirSync` / `statSync` 再帰 |
| コスト | 再ビルド要否チェックのたび同期 walk（ランタイムホットパスではない） |
| 案 | `fs.watch` 世代カウンタ、または非同期 walk |

### 32. [低] sysmon が visibilitychange のたび即 refresh（interval に加えて）

| 項目 | 内容 |
| --- | --- |
| 場所 | `use-system-monitor.ts` ~66–68 |
| 案 | stale 判定（例: 10s 未満なら skip）を visibility ハンドラにも |

### 33. [低] `todoProgressCache` が挿入順 FIFO（真の LRU ではない）

| 項目 | 内容 |
| --- | --- |
| 場所 | `harness.ts` ~697–713（上限 2048） |
| 案 | get 時に再挿入する簡易 LRU |

---

### 第2巡で見たが優先度を上げなかったもの

- `bots-events-hub` のタブ共有 EventSource（既に接続予算に配慮済み）
- CodexBar / GlobalAttention / Sidebar dirty 連動（第1巡 #15–16）
- `web-build-mirror` バイト比較（第1巡 #20）
- relay outbox レコードキャッシュ／listing stamp（実装済み。残るのは tick 間隔 #23）

---

## 既存監査との対応（クイック参照）

| 本メモ | 既存 |
| --- | --- |
| P1-1 BotView SSE | BUGS-PERF P5 |
| P1-4〜6 MCP/codemode | PI-MCP-CODEMODE-AUDIT |
| P2-9〜13 PowerShell / git / goal-loop / models | BUGS-PERF P5 一部修正済み |
| P2-14 `!command` spawnSync | PI-MCP + 起動コスト |
| P3-19 プロファイル | BUGS-PERF |
| P3-20 mirror | BUGS-PERF 見送り |
| 第2巡 #21–33 | 本メモ新規（BUGS/PI-MCP 非再掲） |

---

## 計測のすすめ

1. 裏に Bot タブ 4 枚開いた状態の Backend の EventSource 本数と CPU
2. 大きな dirty worktree で edit 1 回後の `computeWatchdogRepoChangeSignature` 壁時計
3. AppStore 読み取り時の `JSON.stringify` 回数
4. TaskView 前面アイドル 1 分の `git status` 回数
5. 連続 reasoning 翻訳 1 分の `cache.json` 書き込み回数とバイト
6. CodeRequestCard を 1 枚開いた 1 分の `GET /api/tasks/:id` 回数と応答バイト
7. ツール実行中の React Profiler「ToolCard」コミット頻度（250ms クロック前後）
8. アイドル 1 分の bot-code-relay tick 実効回数
9. GraphPanel working 中 1 分の `git log` プロセス数
10. sysmon 初回 `/api/sysmon/usage` の壁時計（Windows）

---


---

## 第3巡（2026-10-04 Asia/Tokyo）— 追加最適化余地

第1–2巡の 32 件は再掲しない。焦点: **sidebar / DiffPane / Goal Loop watchdog / Host tray / routines / permission skill-paths / computer-use 画像 / secret-file icacls / port スキャン**。

| 第3巡のみ | 件数 |
| --- | --- |
| 高 | 3 |
| 中 | 6 |
| 低 | 3 |
| 小計 | **12** |
| 累計 | **44**（高12 / 中20 / 低12） |
| スキャン HEAD | `6ec20371` |

### 推奨着手順（第3巡分）

1. **#34** Bot sidebar の全 Bot セッション末尾読取＋クライアント `JSON.stringify` 署名
2. **#35** DiffPane のフル `/api/diff/files`（count 無し）を遅延／段階化
3. **#36** Goal Loop 5s watchdog の間隔・条件見直し
4. **#37–42** Host tray health、routines 同期走査、skill-paths、CU jpeg、icacls、port-scanner
5. **#43–45** 短命 200ms abort poll、5分 commit ポール、sqlite rebuild（冷パス）

### 34. [高] Bot sidebar 刷新が全 Bot のセッション末尾＋一覧を毎回読む

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/app/api/bots/sidebar/route.ts`（`listTasks` + `readSessionLastMessage` × Bot 数 + `listBotCodeRequestsForBots`）、クライアント `bot-sidebar-store.ts` で `JSON.stringify({bots,rooms})` 署名比較 |
| コスト | Sidebar / dirty 連動のたび N 本のセッション `stat`+末尾読（大きな JSONL は末尾スライスだが Bot 数で線形）。クライアントは変化判定に全ペイロードを stringify |
| 既存監査と重複 | なし（relay outbox 一括読は済。**プレビュー読と署名が残課題**） |
| 案 | 末尾メッセージを Bot 側に短キャッシュ（mtime+size）、dirty 時だけ対象 Bot を再読。署名は長さ+hash（xxhash）や ETag。SSE/dirty で差分パッチ |
| 効果見込み | Bot 数十件時の sidebar 刷新レイテンシと CPU 大幅減 |

### 35. [高] DiffPane が開くたびフル `/api/diff/files`（diff 本文・untracked 読込）

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/task/DiffPane.tsx` `load` → `getJson("/api/diff/files", { directory })`（`count=1` 無し）。`refreshKey` でも再実行 |
| コスト | TaskView worktree は count モード（#7）だが、Diff パネルは **フル diff + untracked 読取**。変更が多いリポで数百 ms〜数秒＋大きな JSON |
| 既存監査と重複 | #7 / #24 とは別 UI・別コスト |
| 案 | 初期はパス一覧のみ（または count）、展開時にファイル単位 `git show`/`diff`。ポーリングせずイベント駆動 |
| 効果見込み | Diff パネル表示時の git/BFF スパイク抑制 |

### 36. [高] Goal Loop がランタイムごとに 5 秒 `setInterval` watchdog

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-goal-loop/index.ts` `SCHEDULE_WATCHDOG_MS = 5_000`、`ensureScheduled` |
| コスト | 稼働中ループ数 × 12 回/分。各 tick でスケジュール再評価・状態読取が走りうる。#13 の rename コストとは別（タイマー密度） |
| 既存監査と重複 | なし |
| 案 | 次発火時刻までの単発 `setTimeout`、または 15–30s＋イベント駆動。アイドル/queued では間引き |
| 効果見込み | 複数 Goal Loop 並行時の拡張 CPU 低減 |

### 37. [中] Host トレイが 5 秒ごとに `/api/health` と binding 再同期

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/index.js` `setInterval` 5000 → `reconcileWebUiBinding` + `refreshStatusMenu`（`isHttpUp(.../api/health)`） |
| コスト | Host 常駐で 12 回/分の HTTP。WebUI 起動中は health TTL（#10）と重なる。トレイ文言更新のため |
| 既存監査と重複 | #9 PowerShell PID とは別。**5s HTTP ポール自体が未掲載** |
| 案 | 15–30s、または WebUI 子プロセスの exit/spawn イベント＋間欠 health。building 中だけ短間隔 |
| 効果見込み | アイドル Host/BFF の常時負荷減 |

### 38. [中] `tickRoutines` が 60 秒ごとに全 Bot の routine JSON を同期走査

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/routines.ts` `ensureRoutineScheduler`（60_000）、`listRoutines` = `readdirSync` + 各ファイル `readFileSync`/`JSON.parse` |
| コスト | Bot×ルーチンファイル数の同期 I/O。件数が増えると分針ごとにイベントループを短時間止める |
| 既存監査と重複 | なし |
| 案 | ディレクトリ mtime キャッシュ、有効ルーチンの次回発火時刻ヒープ、変更時だけ再読 |
| 効果見込み | ルーチン大量時の分単位ジッタ低減 |

### 39. [中] permission-gate `bundledSkillPaths` が extensions を同期 `readdirSync`

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-permission-gate/skill-paths.ts` |
| コスト | スキルパス解決のたび extensions 配下を同期走査＋`statSync`。セッション開始・プロンプト加工で繰り返し呼ばれると積み上がる |
| 既存監査と重複 | なし |
| 案 | プロセス寿命キャッシュ（または mtime）、起動時一度だけ走査 |
| 効果見込み | セッション開始の同期ブロック短縮 |

### 40. [中] computer-use がツール結果に `jpegBase64` をインライン投入

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-computer-use/src/bridge.ts`（`AUTO_IMAGE_MAX_DIMENSION = 900`、fallback 時 `content.push({ type: "image", data: jpegBase64 })`） |
| コスト | 画像が会話コンテキスト・トークン・メモリに直載。連続 observe で履歴が膨らむ |
| 既存監査と重複 | なし（MCP structuredContent #5 とは別経路） |
| 案 | 参照 ID＋ファイル保存、モデルへは縮小/間引き、同一画面の重複添付抑制 |
| 効果見込み | CU 多用セッションのコンテキスト肥大とレイテンシ抑制 |

### 41. [中] `writeSecretFile` が成功時も毎回 Windows `icacls` を spawn

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/secure-file.js` `restrictToCurrentUser`（`icaclsUsable===false` のときだけスキップ。成功時は毎書き込み spawn） |
| コスト | 翻訳 cache 連打（#8）と複合すると icacls プロセスが連発。単発は軽いがホットパスでは効く |
| 既存監査と重複 | #8 は stringify/書込。**icacls コストは未分離** |
| 案 | 同一パスの ACL 適用済みを短 TTL/プロセス寿命でメモ化。debounce flush（#8）と併用 |
| 効果見込み | 連続秘密ファイル書込時の Host スパイク低減 |

### 42. [中] Host port / stale-port が同期 `execFileSync`/`execSync`

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/port-scanner.js`、`host/src/stale-port.js` |
| コスト | 起動・再バインド・競合解消でネット統計コマンドを同期実行し Host を止める |
| 既存監査と重複 | #9 の PowerShell PID とは別ユーティリティ |
| 案 | async `execFile`、結果短 TTL、Linux は `/proc/net` 直読 |
| 効果見込み | 起動・ポート衝突時の体感改善 |

### 43. [低] Auto-agent ルーティング中の 200ms `setInterval` abort 監視

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/harness.ts` ~8992–9009（`resolveAutoAgent` 中のみ） |
| 評価 | 短命。`AbortSignal` を所有者変更に直接繋ぐ方がきれいだが実害は小さい |

### 44. [低] Sidebar の latest-commit 5 分ポール

| 項目 | 内容 |
| --- | --- |
| 場所 | `Sidebar.tsx` `setInterval(..., 300_000)` |
| 評価 | 頻度は低い。イベント駆動化の余地のみ |

### 45. [低] memory `better-sqlite3` ABI 不一致時の同期 `npm rebuild`

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-memory/src/store/sqlite-native.ts` `spawnSync` rebuild |
| 評価 | 冷パス（Node 更新後）。起動ブロッキングは長いが稀 |

---

### 第3巡で見たが優先度を上げなかったもの

- DiffPane の `git/branches` + `git/pr` メタ（フル diff より軽い。#35 と同時に遅延可）
- `readSessionLastMessage` の末尾スライス最適化（既実装。残るのは呼び出し頻度 #34）
- relay outbox / bots-events-hub（第2巡で扱い済み）
- CodexBar / Attention dirty（第1巡）

---

### 計測追加（第3巡）

11. Bot 20 件時の `GET /api/bots/sidebar` 壁時計とセッション `stat` 回数
12. 変更 200 ファイルの DiffPane 初回 `/api/diff/files` バイトと時間
13. Goal Loop 3 本並行時の `ensureScheduled` 呼び出し/分
14. Host アイドル 1 分の `/api/health`（トレイ由来）回数
15. 翻訳 30 回連続時の `icacls` プロセス起動回数


---

## 第4巡（2026-10-04 Asia/Tokyo）— 追加最適化余地

第1–3巡の 44 件（#1–#45）は再掲しない。焦点: **メッセージ描画 / SSE snapshot / Chrome cookies / accounts I/O / missions store / Settings ファンアウト / 会話キャッシュメモリ / 大ファイル scan / agents-md**。

| 第4巡のみ | 件数 |
| --- | --- |
| 高 | 3 |
| 中 | 6 |
| 低 | 3 |
| 小計 | **12** |
| 累計 | **56**（高15 / 中26 / 低15） |
| スキャン HEAD | `6ec20371` |

### 推奨着手順（第4巡分）

1. **#46** Task/Bot タイムラインのウィンドウ／仮想化
2. **#47** フル SSE snapshot のメッセージ同梱をさらに間引き（delta 優先の徹底）
3. **#48** Chrome Cookies DB の全コピー回避
4. **#49–54** accounts キャッシュ、missions 走査、Settings 束ね API、会話キャッシュ、64MB scan、agents-md
5. **#55–57** snapshot 100ms 残余、log-file、冷パス

### 46. [高] TaskView / BotView が履歴メッセージを仮想化せず全件描画

| 項目 | 内容 |
| --- | --- |
| 場所 | `TaskView.tsx` `visibleMessages`〜`renderedMessages`（フィルタのみ、ウィンドウ無し）、`BotView` メッセージリスト同様。`react-markdown`（#29）・ToolCard 経過クロック（#22）と複合 |
| コスト | 数百メッセージで DOM/React コミットが線形増大。ストリーム中は末尾更新でも祖先が再評価されやすい |
| 既存監査と重複 | #22/#29 は部品コスト。**リスト長そのものが未掲載** |
| 案 | 表示ウィンドウ（例: 直近 80＋アンカー周辺）、`content-visibility`、または react-virtuoso。ジャンプ用インデックスは軽量 ID 配列のみ保持 |
| 効果見込み | 長会話のスクロール／入力遅延を大幅改善 |

### 47. [高] `emitTaskSnapshot` 既定がフルメッセージ投影を SSE に載せる

| 項目 | 内容 |
| --- | --- |
| 場所 | `harness.ts` `emitTaskSnapshot` → `liveSnapshotFields(..., includeMessages=true)`。高頻度は delta（`emitTaskDelta`）＋`SNAPSHOT_THROTTLE_MS=100`（`snapshot-schedule.mjs`） |
| コスト | ライフサイクル／非 delta 経路では全 `snapshotMessages` 結果を JSON 化して送る。長い履歴で BFF CPU・帯域・クライアント parse が跳ねる。リスナー 0 ならスキップ済み |
| 既存監査と重複 | BotView SSE 接続数（#1）とは別。**ペイロード肥大** |
| 案 | 接続済みクライアントに `cachedSession` があるときは delta/署名のみ。フルは初回・履歴リセット・明示 refresh。throttle を 150–250ms に |
| 効果見込み | ストリーム中以外の snapshot バーストと再接続コスト削減 |

### 48. [高] web-access がブラウザ Cookies DB を毎回 `copyFileSync` 全コピー

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-web-access/chrome-cookies.ts`（`mkdtempSync` + `copyFileSync(cookiesPath, tempDb)`、sidecar もコピー） |
| コスト | Chromium Cookies は数百 MB になり得る。認証付き fetch のたびディスク全コピー＋SQLite 読。並列リクエストで乗算 |
| 既存監査と重複 | なし |
| 案 | mtime+size でプロセス内キャッシュ、WAL 対応の短命共有コピー、必要ホストの行だけ抽出、コピー中のロック待ち短縮 |
| 効果見込み | ブラウザ Cookie 利用時の初回／反復レイテンシとディスク I/O 削減 |

### 49. [中] `listAccounts()` が呼ぶたびに `accounts.json` を `readFileSync`（mtime キャッシュ無し）

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/accounts.ts` `readAccountsFile` / `listAccounts`。`harness` の models・health・provider 経路から高頻度呼び出し |
| コスト | health TTL（#10）内でもモデル組立で複数回ディスク読。小さな JSON だがホットパスの同期 I/O |
| 既存監査と重複 | #10 は listModels 本体。**accounts 読が未分離** |
| 案 | mtime+size メモリキャッシュ、書込時 invalidate |
| 効果見込み | ポーリング高峰時の微小だが積み上がる同期コスト除去 |

### 50. [中] missions `listMissions` がディレクトリ全 JSON を同期読・パース

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-subagents/src/missions/store.ts` `readdirSync` + 各 `readFileSync`/`JSON.parse`（index 経路も二重読あり） |
| コスト | ミッション数に比例して UI/ツール呼び出しがブロック。履歴が増えると顕著 |
| 既存監査と重複 | なし（watchdog #2 とは別） |
| 案 | インデックス＋mtime キャッシュ、一覧はサマリのみ、詳細は遅延読 |
| 効果見込み | ミッション一覧・resume 判定のレイテンシ改善 |

### 51. [中] Settings 各パネルがマウント時に `/api/models` 等を並行ファンアウト

| 項目 | 内容 |
| --- | --- |
| 場所 | 例: `CompactionSettings.tsx`（`/api/models` + 複数 settings + cache-warming）、`AgentsSettings.tsx`（agents+models）、他パネル同様 |
| コスト | 設定画面を開くたび models カタログ再同期（#10 の重い処理）が複数パネルで重複しうる |
| 既存監査と重複 | #10 TTL。**UI 側の束ね不足** |
| 案 | 共有 React Query／context で models を1回、settings はバンドル API（1 レスポンス） |
| 効果見込み | 設定タブ初回表示の待ち時間短縮 |

### 52. [中] `conversationCache` が最大 128 件の全文会話をメモリ保持（FIFO）

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/direct-session.ts` `CONVERSATION_CACHE_MAX_ENTRIES = 128` |
| コスト | 各エントリはパース済み会話配列。大きなセッション×128 でヒープ増。真の LRU ではない（#33 と同型） |
| 既存監査と重複 | #30 offline snapshot、#33 todoProgress とは別 Map |
| 案 | 件数を減らす／弱参照／要約のみキャッシュ、get 時再挿入 LRU |
| 効果見込み | 長時間稼働 WebUI の RSS 安定化 |

### 53. [中] work summary 経路が最大 64MB までセッションをスキャンしうる

| 項目 | 内容 |
| --- | --- |
| 場所 | `direct-session.ts` `LARGE_FILE_SCAN_MAX_BYTES = 64_000_000`（末尾で不足時の追加スキャン） |
| コスト | 巨大 transcript で同期読が数十 MB。サイドバー／要約系が偶発的に踏むと BFF が固まる |
| 既存監査と重複 | #34 末尾プレビューは 1MB 窓。**work summary の上限が別** |
| 案 | 既定上限を数 MB に、バックグラウンド非同期、またはインデックス永続化 |
| 効果見込み | 巨大セッションでのテールレイテンシ事故防止 |

### 54. [中] `agents-md` が AGENTS.md 等を同期 `readFileSync`／複数 `stat`

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/agents-md.ts` |
| コスト | API／プロンプト組立で毎回同期 I/O。大きい AGENTS.md で目立つ |
| 既存監査と重複 | なし |
| 案 | mtime キャッシュ、サイズ上限、非同期 fs |
| 効果見込み | エージェント設定・プロンプト準備のブロック短縮 |

### 55. [低] `SNAPSHOT_THROTTLE_MS = 100` のさらなる間引き余地

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/snapshot-schedule.mjs` |
| 評価 | delta 経路は既にある。100ms→200ms は体感と CPU のトレードオフ（#47 の一部） |

### 56. [低] `log-file.js` が 64 書き込みごとに `statSync` 再同期

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/log-file.js`（BUGS-PERF で毎行 stat から改善済み） |
| 評価 | 残余。さらに間引く価値は小さい |

### 57. [低] ProviderAuth の OAuth `EventSource` / `pi-update` の同期 spawn

| 項目 | 内容 |
| --- | --- |
| 場所 | `ProviderAuthPanel.tsx` EventSource、`host/src/pi-update.js` `spawnSync` |
| 評価 | 操作時のみ。常時ホットパスではない |

---

### 第4巡で見たが優先度を上げなかったもの

- `emitTaskDelta` の latest-only 投影（既に良い。残課題はフル snapshot #47）
- `pendingTaskDirty` 50ms coalesce（妥当）
- conversation / lastMessage の末尾読ウィンドウ（既実装。呼び出し頻度は #34）
- CodexBar / sysmon / browse（既掲載）

---

### 計測追加（第4巡）

16. メッセージ 500 件の TaskView でストリーム 10s の React commit 数と長タスク
17. 同一条件での SSE snapshot 平均バイト（delta 比）
18. Cookie 利用 1 回あたりの Cookies ファイルサイズと `copyFileSync` 時間
19. 1 分の health ポール中 `readAccountsFile` 呼び出し回数
20. missions 100 件時の `listMissions` 壁時計

---

## 第5巡（2026-10-04 Asia/Tokyo）— 追加最適化余地

読み取り専用の追加スキャン。**#1–#57 は再掲しない。** 本巡は Host bundle 世代計算・hang-watchdog 指紋・Intercom project-agent／name ポール・live partial 出力 Map・pretty JSON 書込・file-lock スピン・添付 base64 再読・設定パネルポールなど、前巡と重複しないホットスポットのみ。

| 項目 | 値 |
| --- | --- |
| HEAD | `6ec20371`（`6ec2037183279e145ef63f7a5b295816d9785113`） |
| 本巡の新規 | **高 3 / 中 6 / 低 3**（合計 **12**；#58–#69） |
| 累計 | **高 18 / 中 32 / 低 18**（合計 **68**） |

### 推奨着手順（第5巡分）

1. **#58** hang-watchdog の全 transcript SHA-256 指紋を軽量カウンタ／差分指紋へ
2. **#59** `bundleGeneration` を size+mtime（またはビルド時に書いた世代ファイル）へ
3. **#60** project-agent の `listSessions` ポール間隔を引き上げ／イベント駆動化

### 58. [高] hang-watchdog `progressFingerprint` が全メッセージ parts を毎 tick SHA-256

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/hang-watchdog.ts`（`progressFingerprint` / `evaluateWatch` / `HANG_WATCHDOG_INTERVAL_MS = 15_000`） |
| 症状 | armed な各 watch について、live の **全 UiMessage・全 parts**（text / thinking / tool output）を `createHash("sha256")` して連結。15s ごと＋進捗判定のたびに再計算。長いセッションでは CPU が線形に膨らむ。加えて `runHangWatchdogTick` は毎 tick `syncMemoryFromDisk()` で Map を全クリア再構築 |
| 既存監査と重複 | なし（#2 は Host change-signature の git hash。本項は runtime hang 指紋） |
| 提案 | メッセージ件数・最終 part 長・toolCallId・末尾ハッシュなど O(1)/O(末尾) の差分指紋。ディスク同期は mtime / 世代でスキップ |

### 59. [高] Host `bundleGeneration` が ~6.2MB `runtime.bundle.mjs` を全文読んで SHA-256

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/backend-launch.js`（`bundleGeneration` → `readFileSync` + `createHash("sha256")`）。実測サイズ約 **6,264,211** bytes |
| 症状 | `planBackend` で generation 未指定のたびにバンドル全文を同期読込・ハッシュ。Host 起動・再計画のたびに数十〜数百 ms 級の同期 I/O+CPU |
| 既存監査と重複 | なし（#20 は web-build-mirror のバイト比較、#31 は web-plan の mtime walk） |
| 提案 | ビルド成果物横に世代ファイル（hash または build id）を書き、実行時はそれだけ読む。フォールバックのみ全文 hash |

### 60. [高] Intercom `project-agent` 既定ポールが 250ms で `listSessions`

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-intercom/project-agent.ts`（`DEFAULT_PROJECT_AGENT_POLL_MS = 250`） |
| 症状 | ペイン起動待ちの間、最大タイムアウト（既定 20s）まで **250ms ごとに** broker `listSessions` を往復。Herdr/project 起動のたびにブローカー負荷とイベントループ占有が跳ねる |
| 既存監査と重複 | なし（#22/#43 の 250/200ms は Web UI 側。本項は Intercom 拡張） |
| 提案 | 既定を 500–1000ms へ。可能なら Herdr 側の完了イベント／長い指数バックオフ |

### 61. [中] Intercom `namePollTimer` 既定 1000ms で presence 名を再送

| 項目 | 内容 |
| --- | --- |
| 場所 | `extensions/leafcode-intercom/index.ts`（`getNamePollMs` 既定 1000、`PI_INTERCOM_NAME_POLL_MS`） |
| 症状 | 接続中セッションごとに 1 秒間隔の name/presence 更新タイマー。名前が変わらない定常時も tick が回る |
| 既存監査と重複 | なし（liveness 既定 30s の `listSessions` プローブとは別） |
| 提案 | 変更検知時のみ送信。ポール間隔を 5–15s へ、またはアイドル時バックオフ |

### 62. [中] `toolPartialOutputByCallId` が `trimLiveTimingMaps` 対象外＋最大 20k を snapshot 経路へ

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/pi/harness.ts`（`trackToolExecutionEvent` / `trimLiveTimingMaps`）。出力整形は `toolResultText` → `MAX_UI_TOOL_OUTPUT_CHARS = 20_000` |
| 症状 | timing Map は 512 で trim されるが **partial 出力 Map は trim されない**（`toolResult` message_end での delete 頼み）。欠落時にエントリ残留。更新のたびに最大 20k 文字が live → snapshot 投影に乗る |
| 既存監査と重複 | #47/#55 は SSE 間引き全般。**Map の trim 欠落と partial 専用保持が未掲載** |
| 提案 | `trimLiveTimingMaps` で partial Map も同期 eviction。ストリーム中は末尾 N 文字のみ保持 |

### 63. [中] ホットパスの `JSON.stringify(..., null, 2)` pretty 書込が常時

| 項目 | 内容 |
| --- | --- |
| 場所 | 例: `backend/core/app-store.mjs`、`backend/core/bot-store.mjs`、`web/src/lib/accounts.ts`、`web/src/lib/agents.ts`、他多数 |
| 症状 | 小さな状態変更でも pretty-print（インデント・改行）で CPU とバイト数が増える。高頻度 RMW では #3 の比較コストとも相乗 |
| 既存監査と重複 | #3 は読取時の二重 stringify 比較。**書込側の pretty 方針自体は未掲載** |
| 提案 | ランタイム状態は compact JSON。人間編集が必要な設定だけ pretty |

### 64. [中] `file-lock` / `directory-lock` が競合時 `Atomics.wait` スピン

| 項目 | 内容 |
| --- | --- |
| 場所 | `backend/core/file-lock.mjs`（待機 10ms）、`directory-lock.mjs`、`mcp-native-credential-owner.mjs`（20ms） |
| 症状 | ロック競合時に同期 `Atomics.wait` ループ。AppStore / BotStore / credential の重なりでイベントループが短時間ブロックしうる |
| 既存監査と重複 | なし |
| 提案 | 非同期ロック（promise + queue）へ。やむを得ない同期 API は待機上限とメトリクス |

### 65. [中] Intercom steer が添付を都度 `readFileSync` + base64（単体最大 8MiB）

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/bot-intercom.ts`（`promptAttachmentsFromIntercomMessage`）。上限は `prompt-images.ts`（単体 8MiB・合計 12MiB） |
| 症状 | busy セッションへの steer で添付ファイルを同期読・base64 化しプロンプトへ。大画像でメインスレッド／Backend がブロックし、メモリに二重保持しうる |
| 既存監査と重複 | #40 は computer-use の jpegBase64 ツール結果。**mailbox 添付の再読経路は別** |
| 提案 | 非同期読、既に data URL なら再利用、steer 時は参照 ID のみ渡してモデル入力直前に展開 |

### 66. [中] LlamaServerSettings がパネル active 中 3 秒ごとに status ポール

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/settings/LlamaServerSettings.tsx`（`POLL_INTERVAL_MS = 3000`、起動待ちは 1000ms） |
| 症状 | 設定パネル表示中ずっと `/api` status を 3s ポール。Host/llama 側の同期プローブと重なると無駄な往復が続く |
| 既存監査と重複 | #11 は models 一覧の readdir。**UI 側の連続ポールは未掲載** |
| 提案 | running/stopped で間隔を変える。visibility ガード。変更イベントがあればポール削減 |

### 67. [低] Host `git-pull.js` が更新時に同期 `spawnSync`（rev-parse ×2 + pull）

| 項目 | 内容 |
| --- | --- |
| 場所 | `host/src/git-pull.js` |
| 症状 | ソース更新パスで git を同期実行。失敗・ネット待ちで Host 起動が止まる |
| 既存監査と重複 | #12/#24 は別 git 用途。**pullLatestSources 自体は未掲載** |
| 提案 | 非同期 spawn、タイムアウト明示、UI からの手動更新へ分離 |

### 68. [低] 完了／注意音が再生のたびに短命 `AudioContext` を生成

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/lib/session-complete-sound.ts` |
| 症状 | 通知のたびに AudioContext + oscillator を組立・破棄。連打時に音声サブシステムの起動コストが乗る |
| 既存監査と重複 | なし |
| 提案 | 共有 AudioContext を再利用し、ページ不可視時は生成しない |

### 69. [低] HomeView が engine 停止中 3 秒ごとに `/api/health` をポール

| 項目 | 内容 |
| --- | --- |
| 場所 | `web/src/components/home/HomeView.tsx`（`engineOk === false` 時、visibility ガード付き） |
| 症状 | エンジン復旧待ちの間 3s health。可視時のみだが、#10/#37 の health コストと重なる |
| 既存監査と重複 | #10 TTL、#37 トレイ 5s。**Home の engine-down 専用ポールは未掲載** |
| 提案 | 指数バックオフ（3s→10s→30s）。Host 側の push / 単発 SSE で復旧通知 |

### 第5巡で見たが優先度を上げなかったもの

- Intercom broker **liveness** 既定 30s の軽量 `listSessions`（#61 name ポールより低頻度）
- ReasoningTranslationSettings の導入中のみ 3s ポール（短命）
- GraphPanel の `layoutGraph` CPU（ポール自体は #24）
- Sidebar `POLL_IDLE_MS = 12_000` の bot sidebar 再読（コスト本体は #34）
- Prompt 画像合計 12MiB 上限そのもの（設計上の天井；#65 は再読経路）

### 計測追加（第5巡）

21. hang-watchdog 1 tick で `progressFingerprint` に要する CPU（メッセージ 200/1000 件）
22. Host 起動 1 回あたりの `bundleGeneration` 壁時計と読バイト
23. project-agent 待ち 10s 中の `listSessions` 回数
24. ツールストリーム中の `toolPartialOutputByCallId` 合計文字数と SSE バイト寄与
25. Llama 設定パネル表示 1 分の status リクエスト数

## 変更していないもの

- 製品ソース・テスト
- `BUGS-PERF-AUDIT-2026-10-03.md`
- `PI-MCP-CODEMODE-AUDIT-2026-10-04.md`
- 第1–4巡本文（#1–#57）は未改変（ヘッダ件数・HEAD・優先度サマリと第5巡追記のみ）
