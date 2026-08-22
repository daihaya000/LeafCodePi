# MEMORY

## 2026-08-22: 思考必須モデルの 400 フォールバック（19b5197）

- `queuePrompt`（全プロンプトの共通経路）で `Reasoning is mandatory ... cannot be disabled` の 400 を検出したら、思考レベルを対応最下位（非off）に引き上げて同じプロンプトを一度だけ再試行。`live.reasoningFallbackTried` で無限ループ防止。UI へ `thinking_level_changed` スナップショット通知

## 2026-08-22: Composer のエージェント選択を「メイン対話」方式へ（本家 LeafCode 準拠）（a009a37）

### 変更前後

| | 挙動 |
| --- | --- |
| 旧 | メインセッションのプロンプトに「サブエージェント『X』に委譲せよ」指示を前置き（decoratePrompt）→ 対話者はメインのまま、subagent ツールで呼ばせるだけ。agent 選択時は subagentPermission を強制 allow |
| 新 | 選択した pi-subagents エージェント定義を DefaultResourceLoader へ適用し、**その人格がタスク全体の対話者になる**（本家 OpenCode が agent の system prompt でセッションを動かす方式と同等） |

### 実装

- `agents.ts`: `loadAgentDefinition(name)` — user/package/builtin の .md を frontmatter+body で読む。既定値は pi-subagents 準拠（`systemPromptMode`: delegate 以外 replace / `inheritProjectContext`: delegate のみ true / `inheritSkills`: false）。enabled のみ
- `buildAgentResourceOptions(def)` → `{ systemPrompt? | appendSystemPrompt?, noContextFiles, noSkills, tools }`。body 空ならプロンプト指定なし（pi-subagents の `--system-prompt` 未付与と同じ）
- `harness.createSession({ agentName })`: resourceLoader options に反映（replace→`systemPrompt`、append→`appendSystemPrompt`、noContextFiles/noSkills、tools allowlist 優先）
- `decoratePrompt` 廃止。agent 選択による subagentPermission 強制 allow も廃止（委譲許可は SubagentPermissionSelect 独立に戻った）
- `TaskSummary.agent` を永続化（store insert/patch）し、WebUI 再オープン（ensureLive）でも人格復元。hang-watchdog 再送も agent メタ維持
- AgentSelect に「エージェント」（value=""）option 追加 → デフォルト persona へ戻せる

### 制限（意図的）

- follow-up（TaskView）での途中切替は不可。system prompt はセッション作成時に固定（DefaultResourceLoader の source は private で差し替え不能）。切替は新規タスクで
- エージェント定義の model/thinking は未適用（UI モデル選択を常に優先）

### 検証

- web vitest **385 passed** / tsc OK / eslint（変更ファイル）警告なし

## 2026-08-22: モデルドロップダウンに CodexBar 使用率連動（赤文字/グレーアウト）

- `/api/models` BFF が `fetchNativeUsage()`（~5分キャッシュ + 2.5s AbortSignal タイムアウト、失敗しても一覧は返す）を呼び、`map.ts` の `CODEXBAR_PROVIDER_MAP`（pi プロバイダID→codexbar ID: anthropic→claude, openai-codex→codex, cursor→cursor 等）経由で各 ModelOption へ `codexbarUsedPercent` / `codexbarMaxed` を付与
- `ModelSelect`: 使用率 ≥75% で行ラベル赤文字（text-danger）、`maxed`（≥99.5%）でグレーアウト+選択不可+「100%」表示、トリガーの選択中モデルも接近時赤文字
- 注意: UI 側（ModelSelect/types）は並列セッションの「サービス品質バッチ6」(6a14a7d) に混入コミットされた。ロジック整理分は 6334fbc。並列作業時は自分の差分範囲を git status で必ず確認

## 2026-08-22: サービス品質バッチ7（WebUI 認証・permission・browse 制限）

全検証: web vitest **384 passed** / **tsc OK** / eslint 警告 1 件 / `next build` **OK** / `build-web.mjs` OK / host test **104 passed**。

### 修正

| 領域 | 問題 | 修正 |
| --- | --- | --- |
| ホスト起動 | `withLocalLeafcodeTempEnv` import 欠落で Tray クラッシュ | `tray-temp.js` import を `webui-auth.js` と併存 |
| WebUI 認証 | Tailscale/LAN 公開時 API/UI が無認証 | 非 loopback バインド時 `ensureWebUiAuth` → token + middleware + `/login` |
| middleware build | Edge で `node:crypto` 不可 | `webui-auth-shared.ts`（Edge 安全）と `webui-auth.ts`（Node route）に分離 |
| permission deny | 危険コマンドのみブロック（UI と不一致） | `deny` 時は **bash 全拒否** |
| permission ask | 連続要求で前件を auto-deny | タスク単位 **FIFO キュー** |
| browse/dirs | 任意絶対パス列挙 | ホーム + 登録プロジェクト配下のみ（403） |

### 新規

- `host/src/webui-auth.js` + test — token 生成/永続化（`%APPDATA%\leafcode-pi\webui-auth.json`）
- `web/src/middleware.ts` — リモート bind 時 token 必須（cookie / Bearer / query）
- `web/src/app/login/` — トークン入力 UI
- `web/src/app/api/auth/webui/route.ts` — cookie 設定
- `web/src/lib/browse-paths.ts` + test

### 運用

- loopback（127.0.0.1）のみ: 認証なし（従来通り）
- Tailscale / 0.0.0.0 / LAN IP: 起動ログに token 表示 → ブラウザ `/login` で入力
- 上書き: `LEAFCODE_PI_WEBUI_TOKEN` 環境変数

### 残存（低優先）

- ~~`listModels()` llama sync 失敗の silent fail~~ → バッチ8で `syncProvidersBestEffort` + `HealthDto.warnings`
- permission `allow` モードは意図的 fail-open（製品方針として文書化済み）

## 2026-08-22: サービス品質バッチ8（provider sync 警告）

全検証: web vitest OK / tsc OK / host test OK。

### 修正

| 領域 | 問題 | 修正 |
| --- | --- | --- |
| listModels | llama/Ollama sync 失敗を `.catch(() => {})` で握りつぶし | `syncProvidersBestEffort` — `console.warn` + `HealthDto.warnings` |

## 2026-08-22: サービス品質バッチ7（WebUI 認証・permission・browse 制限）

全検証: web vitest **377 passed** / **tsc OK** / eslint 警告 1 件（no-img-element）/ `next build` **警告 0** / host test **100 passed**。

### 修正

| 領域 | 問題 | 修正 |
| --- | --- | --- |
| Turbopack build | dynamic fs trace 警告 12 件 → プロジェクト全体トレース | 動的 `path`/`fs` 呼び出しに `/* turbopackIgnore: true */`（8 ファイル） |
| ensureLive | 同一タスク並行オープンで Pi セッション二重生成・リーク | per-task `ensureLiveInflight` + `attachSession` で旧 session dispose |
| unrevertTask | `getTaskDetail` 未 await で SSE snapshot が不完全 | `await getTaskDetail(id)` に統一 |
| `/api/models` | CodexBar コールド fetch が最大 ~30s ブロック | `AbortSignal.timeout(2500)` best-effort |
| ModelSelect | プロバイダー使用率が UI に未反映 | CodexBar usage 付与 + 75% 赤 / 100% 無効化 |

### 新規テスト

- `web/src/app/api/models/route.test.ts` — `attachCodexBarUsage`, `CODEXBAR_PROVIDER_MAP`
- `web/src/components/ModelSelect.test.ts` — `modelNearLimit`, `modelLimitReached`

### 残存（次バッチ候補・バッチ7で解消済み項目は MEMORY バッチ7参照）

- ~~Tailscale/LAN 公開時 WebUI 無認証~~ → バッチ7で token 認証
- ~~permission deny セマンティクス~~ → バッチ7で bash 全拒否
- ~~permission 連続要求 auto-deny~~ → バッチ7でキュー化

## 2026-08-22: サービス品質向けバグ修正バッチ

全検証: web vitest **364 passed** / tsc OK / eslint 1 warning（no-img-element のみ）/ `next build` OK / host test **95 passed**。

### P0 修正

| 領域 | 問題 | 修正 |
| --- | --- | --- |
| 巻き戻し | `revertLeafId` を navigate **後**に保存 → unrevert 無効 | navigate **前**の leaf id を `captureRevertLeafId` で保存 |
| 巻き戻し UI | 新規プロンプト後も「巻き戻し中」／誤復元 | `promptTask` で `revertLeafId` クリア、TaskView 送信成功・taskId 変更で state リセット |
| 権限モード | Composer の allow/ask/deny が Pi に未反映 | `permission-gate-config.ts` — JSON + extension context。`createSession` / `promptTask` で適用 |
| getTaskDetail | セッション読込失敗を握りつぶし空タイムライン 200 | 404/503 を throw |
| ensureLive | タスク不在が 500 | `{ status: 404 }` |
| SSE | snapshot の `JSON.parse` 未保護 / throttle 破棄 | try/catch、unsubscribe で flush |
| llama-server | ポート未伝達・リトライ全 kill | launcher `SERVER_PORT`、ポート限定 taskkill |
| 翻訳 host | stdin 並行 write 混線 | write キュー + バッチ逐次 |
| WebUI | restart レース / quit 時 build 残存 | `restarting` ガード、build proc kill |

### テスト修正

- `hang-watchdog.test.ts` import パス
- `extensions.test.ts` bundled 優先の期待値

### 残存（次バッチ）

- Turbopack dynamic fs trace 警告（build 実測で要確認）

## 2026-08-22: サービス品質バッチ5（stale rebuild・bridge・flaky test）

全検証: web **368 passed** / **tsc OK** / host **100 passed**。

### 修正

| 領域 | 問題 | 修正 |
| --- | --- | --- |
| stale rebuild | 失敗後も古い本番を黙認（ソースが新しいまま） | `staleRebuildFailureAction` — prod で still stale なら起動失敗 |
| Turbopack trace | harness が `extensions/` を repo 外 import | `web/src/lib/pi/webui-permission-bridge.ts` へ移動（globalThis 共有） |
| translation test | Windows EPERM on rmSync | `cleanupTempDir()` — stop + 150ms + maxRetries |

## 2026-08-22: サービス品質バッチ4（guard・tsc・P2）

全検証: web vitest **368 passed** / **tsc OK** / host test **97 passed** / eslint 警告 1 件。

### 修正

| 領域 | 問題 | 修正 |
| --- | --- | --- |
| build guard | netstat 失敗時 fail-open | fail-closed |
| qwen-cloud.ts | tsc 4 件 | 引数なし呼び出しに統一 |
| 保護パス | substring 誤ブロック | セグメント一致 |
| abort / SSE | 無エラー・error 残存 | `abortWorking()`、再接続成功時 clear |
| events route | enqueue 未保護 | send try/catch |

## 2026-08-22: サービス品質バッチ2（handoff / control / permission ask）

全検証: web vitest **367 passed** / host test **97 passed**（tsc は qwen-cloud.ts の既存 4 件のみ）。

### P0/P1 修正

| 領域 | 問題 | 修正 |
| --- | --- | --- |
| build handoff | `POST /restart/webui` の 202 のみで成功扱い | `waitForWebUiHealth()` で `/api/health` をポーリング（90s）。失敗時 `manual` |
| control server | 起動失敗でもホストがサイレント継続 | `stopWeb` + lock 解放 + `process.exit(1)` |
| permission ask | headless BFF で ask = 常時ブロック | `webui-bridge`（globalThis）+ `permission-prompt` + SSE + API + TaskView 許可/拒否 UI |

### 新規

- `extensions/leafcode-permission-gate/webui-bridge.ts`
- `web/src/lib/pi/permission-prompt.ts` + test
- `web/src/app/api/tasks/[id]/permission/route.ts`

## 2026-08-22: サービス品質バッチ3（permission 永続化・SSE・build exit）

全検証: web vitest **368 passed** / host test **97 passed**。

### 修正

| 領域 | 問題 | 修正 |
| --- | --- | --- |
| permission mode | lazy-load で disk の mode が `"ask"` に上書き | `readPermissionGateConfig` + 明示指定時のみ persist |
| PermissionSelect | localStorage のみ | `POST /api/tasks/:id/permission-mode` |
| build-web | handoff `"manual"` でも exit 0 | `main()` が 1 を返す |
| SSE | 404/503 後も無限再接続 | サーバー `event: error` で再接続停止 |
| initPromise | 初期化失敗が永久化 | 失敗時 `initPromise = null` |
| stale build | `extensions/` 未監視 | `isWebBuildStale` に sibling `extensions/` |

## 2026-08-22: 無言終了対策（本家 LeafCode 移植）

本家 OpenCode 版 LeafCode の `aborted-resume.ts` / サーバー側 `hang-watchdog.ts` / TaskView 再開 UI を Pi 向けに移植。

### 手動再開

- `web/src/lib/aborted-resume.ts` — 中断（abort エラー / 手動停止）・無言終了ターンの判定、`findResumableTurn()`
- `TaskView` — 「応答がありませんでした」/ Aborted バナー + 「再開」ボタン（同じプロンプト・画像・モデルを再送）
- `abortTask` 時に `manualAbortedAssistantId` を SSE snapshot へ載せ、Pi が error を付けない中断も再開対象に

### 自動ハング再開

- `web/src/lib/pi/hang-watchdog.ts` — 15s 間隔、無活動が `hang-timeout` 超で abort → 同プロンプト再送（`hang-retry` マーカー付き）
- 監視状態は `%APPDATA%/leafcode-pi/hang-watches.json` に永続化（WebUI 再起動後も継続）
- `queuePrompt` 送信時に watch を arm（Goal Loop 経路は対象外）
- 設定 → 一般「ハング判定時間」（既定 5 分、`web-settings.json` + localStorage ミラー）

### 表示

- hang-retry 用 user メッセージは transcript から非表示（`hangRetry` / HTML コメント prefix）
- 自動再開が起きた回数をタイムライン上部に通知

### 検証

- vitest: `aborted-resume.test.ts` / `hang-retry.test.ts` / `hang-watchdog.test.ts` — 10 passed
- `tsc --noEmit` 成功

## 2026-08-22: ペイン分割の開始操作

1 ペイン・1 タブ時はタブバーごと非表示になるため、唯一の `addPane` ボタンへ到達できなかった。TaskView ヘッダーにデスクトップ用の「新しいペインを追加」ボタンを追加し、空ペイン作成後に Sidebar タスクをドロップして分割できるようにした。

## 2026-08-22: 試行時間が必ず 0s になるバグ

### 原因

`messages.ts` の `projectPiMessages` が assistant の応答時間を「直前レコードの timestamp との差分」で近似していた。しかし Pi SDK（pi-ai の各 stream()）は assistant メッセージを**生成開始時**に `timestamp: Date.now()` で作るため、直前レコード（user / toolResult）との差分は常に数十ミリ秒 → `formatElapsed` の floor で全行 "0s"。JSONL エントリ側の wrapper timestamp は書き込み時刻なのでデータは正常（差分 6〜131 秒を確認済み）。

### 修正

- 誤った差分近似を削除（messages.ts）
- `applyThroughput`（harness.ts、export 済み）で throughput timing の `lastTokenAtMs − startedAtMs`（TTFT 込み実測値、永続化エントリから復元も可）を `responseDurationMs` として注入。timing 無しのメッセージは非表示（偽の 0s を出さない）
- 回帰テスト: harness-prompt.test.ts `applyThroughput` describe

### 注意

Pi の assistant timestamp = 生成開始時刻、という意味論。今後タイムスタンプ差分で所要時間近似しないこと。


## 2026-08-20: LeafCodePi MVP を新規構築

OpenCode 版 LeafCode（`C:\Users\Daichi\OneDrive\AI\OpenCode\LeafCode`）の UI/UX 骨格を維持した、Pi Coding Agent 向け最低限フロントエンドをこのリポジトリに追加した。

### 方針

- OpenCode / `opencode serve` は使わない。
- `@earendil-works/pi-coding-agent` の SDK（`createAgentSession` + `ModelRuntime`）を Next.js BFF に埋め込む。
- 見た目は LeafCode と同じトークン（`--bg` / Geist / GhostSelect / composer カード / サイドバー）。
- MVP の範囲: プロジェクト追加、ホーム composer、タスクタイムライン + SSE、モデル選択、設定のエンジンタブ。

### 構成

- `web/` — Next.js 15.5 + React 19
- `web/src/lib/pi/harness.ts` — プロセス内シングルトン。タスクごとに AgentSession を保持し、prompt は HTTP を待たせず SSE で流す
- `%APPDATA%\leafcode-pi\store.json` — プロジェクト / タスクメタ
- Pi セッション本体は `~/.pi/agent/sessions/`

## 2026-08-20: start.bat とタスクトレイ常駐

`start.bat` → `scripts/start-webui.bat` → `host/src/index.js`（systray2）で Next.js を起動し、通知領域に常駐する。

### 起動

- bat は ASCII / CRLF / BOM なし。日本語は `scripts/setup-messages/*.txt`（UTF-8 CRLF）を `chcp 65001` 後に `type`。
- 既定: `LEAFCODE_PI_HOST=tailscale`、`LEAFCODE_PI_PORT=3010`、`LEAFCODE_PI_MODE=prod`。
- `tailscale` は NIC 名 Tailscale または CGNAT `100.64.0.0/10` の IPv4 にバインド。未検出時は `127.0.0.1`。ブラウザ/ヘルスは `0.0.0.0` を使わず `publicHost` 経由。
- `.next/BUILD_ID` が無ければ `next build`。ソース（`web/src` など）が BUILD_ID より新しければ stale として再ビルド（本家 LeafCode と同じ）。
- stale 再ビルド失敗時は既存の production build を継続。完全欠落時のみ `next dev` にフォールバック。
- トレイ: Open browser / 稼働状況 / Restart WebUI / Quit。OneDrive 上の TEMP 回避のため起動時だけ `%LOCALAPPDATA%\leafcode-pi\tmp`。
- 二重起動は `%APPDATA%\leafcode-pi\host.lock`。死んだ PID なら stale として削除。
- `node src\index.js` の相対 argv は `host/src/entry.js` の `resolve()` で判定。
- デスクトップショートカットは `scripts/create-shortcut.bat` → `LeafCodePi.lnk`。

### LeafCode との同時起動（衝突回避）

| | LeafCode | LeafCodePi |
| --- | --- | --- |
| WebUI | :3000 | :3010 |
| 環境変数 | `LEAFCODE_*` | `LEAFCODE_PI_*` |
| データ / lock / log | `%APPDATA%\leafcode` | `%APPDATA%\leafcode-pi` |
| トレイ TEMP | `%LOCALAPPDATA%\leafcode\tmp` | `%LOCALAPPDATA%\leafcode-pi\tmp` |
| ショートカット | `LeafCode.lnk` | `LeafCodePi.lnk` |
| title | LeafCode | LeafCodePi |

LeafCode 側の制御ポート 18765 / broker 18766 / OpenCode 4096 は使わない。

### 検証

- `npm --prefix host test` — 19 passed（bat エンコーディング、起動プラン、隔離）
- ヘッドレススモーク: `LEAFCODE_PI_HEADLESS=1` `LEAFCODE_PI_NO_BROWSER=1` `LEAFCODE_PI_PORT=3010` で `GET /api/health` 200、dataDir は指定の TEMP

### 残存（意図的に未実装）

- worktree / 一時コピー、権限カード、差分ペイン、ゴールループ、Caddy、ネイティブ exe ランチャー
- Pi の bash は Windows で Git Bash などが必要
- トレイアイコン画像は LeafCode と同じ葉。ツールチップは LeafCodePi Host

## 2026-08-20: OpenAI / Anthropic サブスクログイン

設定画面から Pi の OAuth を起動できるようにした。

- Anthropic → Claude Pro/Max（`oauth`）
- OpenAI Codex → ChatGPT Plus/Pro（`openai-codex` / `oauth`）
- BFF: `POST /api/providers/:id/login` + SSE events + answer/cancel、`POST .../logout`
- 認証情報は `~/.pi/agent/auth.json` に保存（OpenCode の auth とは別）
- 検証: `vitest` 7 passed、`tsc --noEmit` 成功

## 2026-08-20: start.bat で stale production を再ビルド

本家 LeafCode と同様、`start.bat` → host 起動時に `isWebBuildStale(web, web/.next)` を見てソースが新しければ `next build` する。

- `getWebLaunchPlan(mode, hasBuild, buildStale)`
- stale 再ビルド失敗時は既存 BUILD_ID を継続
- bat は「Existing build found; host will rebuild if sources are newer.」を表示

## 2026-08-21: 設定「モデル」タブ（有効・無効・並び替え）

本家 LeafCode のモデルタブから、プロバイダー/モデル一覧だけを移植。

- 状態: `%APPDATA%\leafcode-pi\provider-model-state.json`（disabled / providerOrder / modelOrder）
- API: `GET/PATCH /api/provider-models`, `PATCH .../order`, `PATCH .../[key]`
- `/api/models` とヘルスの modelCount は有効なものだけ
- デフォルトモデル / 価格 / アイコン / Auto は未移植

## 2026-08-21: タスク画面のモデル切替が効かない不具合

### 原因

`TaskView` が `POST /api/tasks/:id/model` の結果をローカル state に反映していなかった。ドロップダウンは `task.providerID::modelID` の制御コンポーネントのため、選択直後に旧値へ戻って見えた。加えて SSE マージが `messages: undefined` で上書きしうる形だった。

### 修正

- レスポンスの `task` で state を更新
- `setTaskModel` 後に SSE snapshot を送る
- snapshot マージで既存 messages を保持

## 2026-08-21: Tailscale にバインド

`start.bat` 既定の `LEAFCODE_PI_HOST` を `tailscale` にした。

- `findTailscaleIPv4()`: NIC 名に Tailscale、なければ `100.64.0.0/10`
- 未検出時は `127.0.0.1` にフォールバック（ログで案内）
- ブラウザ / ヘルス URL は `publicHost`（`0.0.0.0` は使わない）
- ローカルのみ: `LEAFCODE_PI_HOST=127.0.0.1` / 全 IF: `0.0.0.0`

## 2026-08-21: llama.cpp (llama-server) 対応

本家 LeafCode の起動制御を移植し、Pi の推論プロバイダーも配線した。

### ホスト

- `scripts/llama-server-load.bat` — ポート **8081**（LeafCode と共有）。`MODEL_FILE` あり → `-m` 単体、空 → `--models-dir` ルーター
- `host/src/llama-server-service.js` + トレイ + 制御プレーン **:18775**（`host-control.json`）
- WebUI「エンジン」タブに起動・停止・パス設定

### Pi 側

- `registerNativeProvider(createLlamaProvider())` — ID `llama.cpp`（ルーター）
- `registerProvider("llama-server")` — OpenAI 互換・単体モデル（設定の GGUF 名）
- 設定: `%APPDATA%\leafcode-pi\settings\llama-server-config.json`

### モデル ID

スタブ `local` は使わない。`GET http://127.0.0.1:8081/v1/models` の id を `listModels` 時に同期する。単体起動 bat は `--alias <gguf名>` を付与。

### 起動時ロード

ルーター起動でモデルが `unloaded` のまま残らないよう、`--no-models-autoload` を外し、bat / UI 起動後に `scripts/llama-server-ensure-loaded.mjs` と `POST /api/llama-server/ensure-loaded` で `/models/load` する。

## 2026-08-21: Cursor サブスク対応

`@rahularya01/pi-cursor` を Web 依存に追加し、`ModelRuntime` 起動時に拡張をロードしてプロバイダー ID `cursor` を登録。

- 設定 → モデル → サブスク一覧にハイライト表示（`SUBSCRIPTION_PROVIDER_IDS`）
- OAuth: 既存の `/api/providers/:id/login` フロー（ブラウザ PKCE）
- Cursor IDE / CLI ログイン済みならトークン自動検出の場合あり
- 非公式拡張。Node 22.19+ 推奨

## 2026-08-21: プロバイダアイコン

本家 LeafCode の `web/public/icons/*` を移植。`providerIconSrc()` + `ProviderIcon` をモデル選択・設定・タイムラインに表示。

### 注意

クライアントの `LlamaServerSettings` は `node:fs` 付きの `host-control` を import しない（`loopback.ts` に分離）。Webpack の UnhandledSchemeError 防止。

## 2026-08-21: 設定に再起動ボタン

設定 → エンジンに「再起動」セクションを追加。トレイの Restart WebUI と同じ経路。

- ホスト制御: `POST /restart/webui`・`POST /restart/host`（:18775、202 後に実行）
- BFF: `POST /api/host/restart`（`target: webui | host`）
- UI: `HostRestartPanel`（確認ダイアログ → ヘルス待ち）
- ホスト全体再起動は lock 解放待ち bat を WMI で起動してから `quit()`

## 2026-08-21: サブスクと有効モデル一覧をモデルタブへ

設定のプロバイダー認証とモデル一覧をエンジンからモデルタブへ移動。エンジンはヘルス / llama-server / 再起動のみ。

## 2026-08-21: 設定ラベル整理

モデルタブ見出しを「プロバイダー」「モデル」に統一。

## 2026-08-21: llama-server 設定のデザイン統一

エンジンタブのローカル LLM セクションを他カード（`rounded-2xl` / `bg-surface` / `h2`）と同じ文脈に揃える。

## 2026-08-21: llama-server Qwen3 effort 切替

`Qwen3.8-27B-Uncensored-GGUF` など Qwen3 系 GGUF で ThinkingSelect が効くようにする。

- モデルを `reasoning: true`、対応レベル `off/low/medium/xhigh`
- リクエスト書換: 段階 effort → `chat_template_kwargs.reasoning_effort`、off → トップレベル `none` + `/no_think`
- （GGUF テンプレは kwargs に `none` を入れると 500 になる）

## 2026-08-21: effort 非対応モデルは ThinkingSelect 非表示

effort オプションがないモデルではドロップダウンを出さない（単独の off ラベルも出さない）。

## 2026-08-21: effort の off ラベルを「デフォルト」に

ThinkingSelect に段階 effort があるとき、`off` の表示を「思考なし」→「デフォルト」に変更。基準（追加思考なし）の相対表現として適切。

## 2026-08-21: モデル選択にプロバイダ／画像アイコン

Composer のモデルドロップダウン各行にプロバイダアイコンと、画像入力対応モデルの Image アイコンを表示。

## 2026-08-21: システムモニター（sysmon）

本家 LeafCode の sysmon を移植。サイドバー下部に CPU / RAM / GPU・VRAM を表示。

- `GET /api/sysmon/usage`（nvidia-smi + Windows AMD カウンター）
- **サーバ側** `collectSystemUsageCached`（既定 TTL 3s + in-flight 合流）。子プロセス連打で BFF を食い潰さない
- クライアント: 展開時 15s / 折りたたみ時 60s。バックグラウンド更新は `quiet`（`setRefreshing` しない）
- 折りたたみ・1/2 列・項目の表示切替を localStorage に保存

## 2026-08-21: llama-server モデル表示名

表示名を `llama-server (Qwen…)` から GGUF 名のみ（例: `Qwen3.8-27B-Uncensored-GGUF`）に変更。

## 2026-08-21: グローバル AGENTS.md（カスタム指示）

設定 → 一般に `~/.pi/agent/AGENTS.md` の編集 UI を追加（プロジェクト単位は未対応）。

- `GET/PATCH /api/agents-md`
- 2MB 上限、シンボリックリンク拒否
- 保存後 `reloadLiveSessionsContext()` で開いている AgentSession に Pi `/reload` 相当を実行（即時反映）

## 2026-08-21: Ollama Cloud プロバイダ

`https://ollama.com/v1`（OpenAI 互換）をプロバイダー ID `ollama-cloud` として登録。

- API キー: 設定画面ログイン、または `OLLAMA_API_KEY`
- モデル一覧は認証後に `/v1/models` から取得
- 設定の推奨枠にハイライト表示

## 2026-08-21: コンテキスト使用量表示

タスク画面ヘッダーに Pi `session.getContextUsage()` のバーを表示。

- `TaskDetail.contextUsage` + SSE snapshot で即時更新
- 使用率 70% で warning、90% で danger 色
- 圧縮直後など tokens 不明時は `?` 表示

## 2026-08-21: モデル別 effort（思考レベル）切替

Pi の `getSupportedThinkingLevels` / `setThinkingLevel` に合わせ、モデルが受け付けるレベルだけを UI に出す。

- `ModelOption.thinkingLevels` を `/api/models` に付与
- ホーム / タスクの `ThinkingSelect`（非対応モデルはセレクト非表示、`off` 表示は「デフォルト」）
- `POST /api/tasks/:id/thinking` でライブセッションへ即時反映
- タスク作成・モデル切替時に clamp

## 2026-08-21: コンテキスト圧縮

Pi `session.compact()` / 自動圧縮設定に対応。

- タスクヘッダー「圧縮」→ `POST /api/tasks/:id/compact`（最大 240s、キャンセルは `/compact/abort`）
- SSE に `isCompacting`、要約は `compactionSummary` → UI の圧縮カード
- 設定 → 一般で自動圧縮 ON/OFF（`~/.pi/agent/settings.json` の `compaction.enabled`、ライブセッションへ即反映）
- 閾値は Pi 既定（reserveTokens / keepRecentTokens）

## 2026-08-21: CodexBar 利用状況表示（ネイティブ API 取得）

**訂正:** 当初は `%APPDATA%\CodexBar\usage-snapshot.json` を読むだけの実装だったが、これは「ネイティブ」ではない。正しくは LeafCodePi の Node BFF が各プロバイダー API をローカル認証情報で叩き、`codexbar.usage-snapshot/v1` 形で返す。

### 実装

- `web/src/lib/codexbar/` — types / export / cache(~5分) / orchestrator / providers
- `GET /api/codexbar/usage` — ネイティブ並列取得（`?refresh=1` で集約キャッシュ無視。429 バックオフは維持）
- ウィジェット ポーリング ~5 分（CodexBarWin 既定と同じ）。タブ復帰は 4 分未満なら再取得しない
- 折りたたみ中はポーリング停止（直近スナップショット表示）。自動更新は `quiet`（スピナー再描画なし）。`now` は 60s ティック
- プロバイダ別キャッシュ + Claude 429 は 15 分バックオフ（直近成功値を stale 表示）
- 同時リクエストは in-flight 共有（Strict Mode 二重起動対策）
- CodexBarWin は **不要**（起動必須ではない）

### v1 対応プロバイダー

| ID | 認証 |
| --- | --- |
| codex | `~/.codex/auth.json`（CODEX_HOME）+ OAuth refresh |
| claude | `~/.claude/.credentials.json` + OAuth refresh |
| cursor | Cursor `auth.json` / `state.vscdb`（node:sqlite） |
| openrouter | `OPENROUTER_API_KEY` |
| synthetic | `SYNTHETIC_API_KEY` |
| commandcode | `COMMAND_CODE_API_KEY` または `~/.commandcode/auth.json` |
| opencode-go | OpenCodeTray DPAPI / Netscape / Chrome·Edge Cookies + `openCodeGoWorkspaceId` |
| ollama | Netscape cookie（`ollama.com/settings` スクレイプ） |
| qwen-cloud | Netscape / Chrome·Edge Cookies 優先、なければ API キー |

### フォールバック（任意・最終手段）

全プロバイダー未設定、または設定済みがすべて失敗したときだけ、既存の `usage-snapshot.json` を読む（パスは `LEAFCODE_CODEXBAR_SNAPSHOT` で上書き可）。デバッグ専用に `LEAFCODE_CODEXBAR_FORCE_SNAPSHOT=1` でファイルのみ。

### 検証

- `npx vitest run`（export / provider parser）
- `npx tsc --noEmit`
- ブラウザでサイドバー CodexBar ウィジェット、または `GET /api/codexbar/usage`

## 2026-08-21: CodexBar enabledProviders（更新するプロバイダー）

本家 LeafCode アドオンと同じく、`%APPDATA%\CodexBar\config.json` の `enabledProviders` でネイティブ取得・表示するプロバイダーを選択できる。

### 実装

- `provider-catalog.ts` — 9 プロバイダー catalog、既定 `["codex","claude","cursor"]`、version = sha256(設定テキスト)
- `GET/PUT /api/codexbar/providers` — 安全な catalog のみ返却（API キー非漏洩）。ファイル無し GET は defaults + version(`"{}"`)。PUT 成功時 `clearCachedUsage()` + `clearProviderCache()`
- `orchestrator` — `resolveEnabledProviderIds()` に含まれるプロバイダーだけ native fetch。スナップショットフォールバックも同集合でフィルタ。in-flight 共有 + プロバイダ別 429 バックオフ- UI: SlidersHorizontal →「更新するプロバイダー」トグルパネル（アドオン dismiss ボタンは無し）

### 検証

- `npx vitest run src/lib/codexbar/ src/app/api/codexbar/`
- `npx tsc --noEmit`
- ウィジェット設定でトグル後、usage が `?refresh=1` で再取得されること

## 2026-08-21: Cookie 系プロバイダー（Ollama / OpenCode Go / Qwen Cloud）

CodexBarWin の cookie スクレイパーを LeafCodePi に移植。**実行時に CodexBarWin は不要**（TRUE native fetch）。

### 共有

- `netscape-cookies.ts` — Netscape 形式（`#HttpOnly_` 対応）、ドメインフィルタ、Cookie ヘッダ
- `chromium-cookies.ts` — Chrome/Edge Cookies DB（DPAPI マスターキー + AES-GCM、node:sqlite）
- `browser-cookies.ts` — OpenCodeTray DPAPI / Netscape / Chromium を統合
- `codexbar-config.ts` — `%APPDATA%\\CodexBar\\config.json` の読み書き（未知フィールド保持）

### 認証パス

| プロバイダー | 主パス | 代替 |
| --- | --- | --- |
| ollama | `%APPDATA%\\CodexBar\\ollama_cookies.txt`（または AgentUsageChecker 系） | — |
| opencode-go | OpenCodeTray DPAPI → Netscape → Chrome/Edge Cookies | workspace ID 自動検出 → config 保存 |
| qwen-cloud | Netscape → Chrome/Edge Cookies（`login_qwencloud_ticket` 等） | API キー（`qwenCloudApiKey` / `ALIBABA_QWEN_API_KEY` / `DASHSCOPE_API_KEY`） |

### 残ギャップ

- OpenCode Go の usage ページ token 集計（TokenSummary）は未移植（RateWindow のみ）
- Chromium App-Bound Encryption（一部企業ポリシー）は未対応
## 2026-08-21: アシスタント応答の tok/s 表示

業界標準の decode throughput で計測（本家 LeafCode の実装は参照しない）。

- 定義: `(outputTokens − 1) / (T_last − T_first)`（TTFT / prefill 除外）。first が取れない場合のみ end-to-end `N / wall` にフォールバック
- harness が `message_start` / `message_update`(text|thinking|toolcall delta) / `message_end` で first・last を記録
- usage.output が来るまでストリーム文字数 / 4 で暫定トークン数
- タスクタイムラインのアシスタント行に `N tok` と `X tok/s` を表示（ホバーで decode / e2e の別）
- Pi セッションに `custom` エントリ `leafcode-pi.throughput` として永続化（再起動・再オープン後も復元）。LLM コンテキストには乗らない

## 2026-08-21: エージェントのベースプロンプト所在

「自己紹介で LeafCodePi と名乗る」は **LeafCodePi 側の専用プロンプトではない**。

| 層 | 場所 | 役割 |
|---|---|---|
| ベース（固定） | Pi パッケージ `buildSystemPrompt`（`pi-coding-agent` の `core/system-prompt.js`） | 「You are an expert coding assistant operating inside pi…」＋ツール一覧 |
| カスタム指示 | `~/.pi/agent/AGENTS.md`（設定 → 一般）＋ cwd 側の `AGENTS.md` 等 | `<project_context>` として追記。ベースの「あなたは誰」を置き換えない |
| スキル | `~/.pi/agent/skills`・`~/.agents/skills` → `formatSkillsForPrompt` | 利用可能スキル一覧を追記 |

LeafCodePi の harness は現状、製品名を system prompt に埋め込んでいない。グローバル `AGENTS.md` が無い状態でもモデルが UI／製品名から「LeafCodePi」と名乗ることはある。

## 2026-08-21: UI 応答性・パフォーマンス

ストリーミング中の固さを軽減:

- harness: `message_update` の SSE スナップショットを 100ms に間引き（他イベントは即時）
- TaskView: メッセージ参照を `stabilizeUiMessages` で再利用 + `PartView`/`MarkdownBody` を memo。SSE 更新は `startTransition`。サイドバー通知は status/title 変化時のみ（`notifyTasksChanged` も 400ms debounce）
- Sidebar: desktop/mobile の二重 body をやめ md 判定で単一マウント（CodexBar/sysmon の二重ポーリング解消）。タスク一覧ポーリングは idle 12s / working 4s
- ProviderModels: トグルを楽観更新（全画面 loading に戻さない）
- `optimizePackageImports: ["lucide-react"]`
- **sysmon / CodexBar**: 上記ウィジェット自体が BFF ボトルネックになり得る → サーバキャッシュ・quiet poll・折りたたみ時の間隔抑制（sysmon 節 / CodexBar 節も参照）

## 2026-08-21: Skills 設定（ON/OFF）

設定 → 一般からグローバルスキルを有効／無効にできる（フォルダ移動なし）。

- 発見: `~/.pi/agent/skills` **と** `~/.agents/skills`（Pi が両方読む。後者に bug-hunt 等が入っていることが多い）
- 無効化: `%APPDATA%/leafcode-pi/skills-state.json`（`disabled: { name: true }`）。モデル無効化と同じパターン
- 実行時: `createSession` が `DefaultResourceLoader.skillsOverride` で無効名を除外。`session.reload()` 時も状態を再読込
- プロジェクト cwd の `.agents/skills` / `.pi/skills` は設定 UI 対象外（セッション cwd 依存）
- `GET /api/skills` / `PATCH /api/skills/:name`（`{ enabled }`）→ 切替後 `reloadLiveSessionsContext()`

## 2026-08-21: Command Code プロバイダ（Go プラン対応）

`pi-commandcode-provider`（[patlux/pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)）を Cursor と同様に BFF へ配線。

- 依存: `pi-commandcode-provider@0.5.1`（TypeScript 拡張を jiti でロード）
- `registerCommandCodeProvider()` → ModelRuntime に `commandcode` を登録
- トランスポート（拡張内）: まず公式 Provider API。`403 upgrade_required`（Go プラン）のときだけ `/alpha/generate` にフォールバック
- 認証: 設定のログイン（OAuth / API キー）、`COMMANDCODE_API_KEY`、`COMMAND_CODE_API_KEY`（互換コピー）、`~/.commandcode/auth.json`
- 設定の推奨枠にハイライト（`HIGHLIGHTED_API_PROVIDER_IDS`）
- 非公式拡張。Command Code の利用規約・プラン条件が適用される

### 表示されないとき

- プロセス内シングルトンが古い初期化のままだと登録漏れになるため、`ensureRuntime` は起動後も未登録なら `registerCommandCodeProvider` を再試行する
- パッケージ解決は `process.cwd()/node_modules/...` フォールバック付き（Next の chunk 上の `createRequire` 対策）
- WebUI / host を再起動すると確実に反映される

## 2026-08-21: メッセージタイムラインが最新へ追従しない

### 原因

`TaskView` の自動スクロールが `messages.length`（と isStreaming / isCompacting）にしか依存していなかった。ストリーミング中は同一メッセージの parts が伸びるだけで件数は変わらないため、本文更新のたびに追従しなかった。

### 修正

本家 LeafCode と同じ stick-to-bottom:

- スクロールコンテナへ `scrollTo({ top: scrollHeight })`
- 依存を `messages` 全体に変更（ストリーム更新でも発火）
- 明示的な上方向スクロールでのみ unstick（内容成長では維持）
- `ResizeObserver` で Markdown / ツールカード等の非同期高さ変化にも追従

### 検証

- `npx vitest run src/lib/scroll-stick.test.ts` — 6 passed
- `npx tsc --noEmit`

## 2026-08-21: 縮小サイドバーのタスクポップアップ

本家 LeafCode と同じく、縮小サイドバーのプロジェクトアイコンからタスク一覧を開けるようにした。

- ホバー対応端末はアイコンのホバー／フォーカスで表示
- タッチ端末はタップで表示し、タスク／新規タスクボタンから遷移
- 表示位置をビューポート内に補正し、Escape・外側クリック・ホバー離脱で閉じる

## 2026-08-21: スマホ表示のヘッダー / Composer 整理

- 本家 LeafCode の構成に合わせ、TaskView はモバイル用ヘッダーを重複表示せず、タスク操作を横スクロール可能なグループに整理。
- 共通 Composer は設定ツールバーを折り返さず横スクロールし、送信ボタンを常時表示。
- `npm run typecheck`、`npm run lint`、`npm run test`（29 files / 230 tests）成功。`next build` は既存の不足ページ（`/api/host/restart` 等）で失敗。

## 2026-08-22: スマホの "This page couldn't load" = ビルド世代の取り残し

症状: PC では正常なのにスマホだけ Next の built-in エラーページ「This page couldn’t load」。

### 原因（実測）

- 稼働中の `next start`（PID 38040 / 10:00 起動 / ミラー `.next` 配信）に対し、19:07 の別ビルドがミラーの `.next` を置き換えた。
- 配信中の HTML は旧 CSS `chunks/32lzx-21-2jd1.css` を参照するがミラー上は新 CSS `chunks/1cm2us_p6_ndy.css` のみ → 旧 CSS が **500**（404 ではない）。
- SSR は `/`・`/settings`・`/task/[id]` すべて 200。JS チャンクはハッシュ不変で 200。CSS だけが消える差分だった。
- PC は旧アセットをキャッシュ済みで気づかず、初回アクセスのスマホだけ壊れる。

### 調査で効いた手順

- 文言の出所特定: `rg -o ".{200}page couldn.{300}" web/node_modules/next/dist/compiled/next-server/app-page-turbo.runtime.prod.js` → Next 16 の built-in error UI と確定（カーリークォート `’` 込み）。
- モバイル UA で HTML を取得し `/_next/static/...` を全部 GET して status を確認 → CSS 500 を発見。
- `productionWebUiIsIdle()` をその場で呼んで `idle=false`（ガード自体は健全）を確認 → 破ったのは `--skip-guard` 経路か fail-open 経路と判断。

### 対策

- `scripts/build-web.mjs` にビルド後の `handOffToServedWebUi()` を追加。稼働中の mirror `next start` を検出したら `POST {hostControlUrl}/restart/webui`。届かなければトレイ再起動を促すメッセージのみ。
- 復旧は `curl -X POST http://127.0.0.1:18775/restart/webui` で即時。再起動後は全アセット 200。

### 副次的に見つかった残置

- `127.0.0.1:3010` を LISTEN する孤児 `next start`（リポジトリ `web/node_modules` 由来）が居て 500 を返す。Tailscale 側とは別プロセスなのでスマホには無関係だが `http://127.0.0.1:3010` は壊れて見える。

### 注意（bash）

- `MSYS_NO_PATHCONV=1` にすると curl の `-o /tmp/x` が Windows パス扱いで書けない。作業ファイルは `C:/Users/Daichi/AppData/Local/Temp/opencode` を使う。
- 未設定だと `for p in / /settings` の `/` が `C:/Program Files/Git/` に化ける。URL を直書きするのが安全。

## 2026-08-22: ローカル LLM に Ornith-1.5-35B-A3B を追加

Ornith-1.5（DeepReinforce、2026-08-20 公開）のうち **35B-A3B MoE** を llama-server に導入。R9700 32GB VRAM 環境での最適解。

### 選定

| サイズ | SWE-bench V | Terminal-Bench 2.1 | 採用 |
| --- | --- | --- | --- |
| 397B MoE | 86.0 | 86.1 | ×（VRAM 足りない） |
| **35B-A3B MoE** | **79.0** | **67.8** | **○ アクティブ 3B/tok で高速** |
| 9B dense | 70.6 | 47.0 | × |

- ファイル: `AtomicChat/Ornith-1.5-35B-A3B-GGUF` の **AD-Q5_K-Q4_K**（22.14 GB、top-1 一致率 93.52% 実測付き）。配置: `C:\Users\Daichi\models\llm\Ornith-1.5-35B-A3B-GGUF\`
- アーキ `qwen35moe`。llama.cpp は PR #19468（2026-02-10 マージ）以降対応 → build 10488 (Vulkan, 8/18) で無パッチ動作
- ハイブリッド注意（40 層中 10 層のみフル注意）で KV が軽く、128K コンテキストでも VRAM 収まる

### 実装（コミット c95d8a6）

- `llama-provider.ts`: `isLlamaOrnithModel()` + `LLAMA_ORNITH_THINKING_LEVEL_MAP`。Ornith は reasoning_effort を持たず `chat_template_kwargs.enable_thinking: false`（思考オフ）のみ。UI マップは off=デフォルト（思考あり）/ minimal=最小（思考なし）。`/no_think` プレフィックスは付けない（Qwen3 専用）
- `scripts/llama-server-load.bat`: `-fa on` + サンプリング既定（temp 0.6 / top-p 0.95 / top-k 20、Ornith コーディング推奨値）を全モードに追加。**REASONING_EFFORT 空 → kwargs を省略する plain モード分岐**（Ornith 起動には空が必要）
- `%APPDATA%\leafcode-pi\settings\llama-server-config.json`: effort 空 / contextLength 131072 / modelFile を Ornith に更新

### 検証実績

- thinking デフォルト: reasoning_content 分離 + 本文「東京」
- enable_thinking:false: 思考なし即答「東京です。」
- **93.3 tok/s**（700 tok 生成・思考オフ・32K ctx）、128K ctx でも 89.9 tok/s
- vitest 12 passed / host test 75 passed / bat 実起動成功

### 教訓

- bat 起動直後の taskkill → 即再起動はヘルス待ち 120s 失敗することがある（ポート解放遅延）。数秒置いて再試行すれば通る
- bash パイプ `cmd //c "call bat" | tail` は start 子プロセスの stdout 継承で EOF 待ちハングする → 出力はファイルリダイレクトへ
- AtomicChat 35B リポジトリに mmproj 無し。画像入力したい場合は mudler APEX-GGUF の mmproj.gguf (0.9GB) + `--mmproj` 追加が必要
- MTP speculative decoding（`--spec-type draft-mtp` + mudler APEX-MTP 版）はフラグ対応済みだが未採用（93 tok/s 出ており追加 17GB DL のコスパ悪し）

## 2026-08-22: Qwen3.8-27B を MTP 推測デコードで最適化（4.45 → 68.6 tok/s）

### 問題

Qwen3.8-27B-Uncensored（アーキ `qwen35` **dense**、block_count=65 / nextn_predict_layers=1 = **MTP テンソル込み**）が Vulkan で tg128 = 4.45 tok/s と異常に遅い。qwen35 dense の Vulkan 性能は既知の構造的問題（llama.cpp issue #20006, #20354; GDN カーネル制約）。同アーキ MoE（Ornith 35B-A3B）は 93 tok/s 出るので dense のみ。

### 解決

GGUF 内蔵の MTP draft head を使う `--spec-type draft-mtp`。issue #24066 の報告通り dense qwen3.5 系では劇的に速くなる:

| 構成 | tok/s | draft acceptance |
| --- | --- | --- |
| 基準（fa on のみ） | 4.45 | — |
| + draft-mtp（直叩き） | 49.6 | 87.4% |
| + draft-mtp（bat・effort low） | **68.6** | **95.6%** |

**約15倍**。コード品質に変化なし。

### 実装（コミット 100872e）

- bat: `SPEC_TYPE` env（既定空）→ `%SPEC_ARGS%` を全 start 行へ。**MTP テンソル無し GGUF（Ornith AtomicChat 版）に draft-mtp を渡すと起動死するため一律付与は不可**（実測で確認済み）
- settings スキーマ: `specType?: "" | "draft-mtp"`（optional で後方互換）、BFF route 検証、host launcher `set "SPEC_TYPE=..."`、エンジンタブ UI セレクト追加
- 運用: モデル切替時に specType も合わせる。Ornith → 「なし」、Qwen3.8 → 「draft-mtp」

### 教訓

- GGUF の MTP 有無はメタデータ `nextn_predict_layers` と block_count（層数+1）で判定できる。python 生パース時は GGUF v3 型テーブル注意（9=array, 8=string）
- llama-bench には spec パラメータがなく、spec decode 効果は llama-server 実測でしか見えない
- bash から bat へ dry-run 引数を渡すときは `cmd //c "set X=Y&& call ...bat /dry-run"` の形にする（裸引数は MSYS パス変換で消える）

## 2026-08-22: 両モデル最終最適化（ubatch 2048 + KV q8_0）

コミット 0cd081a。リサーチ: llama.cpp 最新は 8/21 リリース（b10488=8/18 と僅差、qwen35 dense TG 改善の chunked GDN カーネル #20377 は未マージ）→ **現行ビルド維持**がリスク対効果で最適。

### 実測（llama-bench / 実API）

| 変更 | Ornith 35B-A3B | Qwen3.8-27B |
| --- | --- | --- |
| ubatch 512→2048 | PP2048 +20%（2783→3355 t/s）、TG 不変 → **実API 93→111 tok/s・プロンプト処理 980ms→118ms** | PP 改善、TG 維持 |
| KV V q8_0（K は f16 が最速） | tg128 +2% 微増 | K/V とも q8_0 で TG 不変・VRAM 半減 |
| llama.cpp 更新 | 見送り（僅差＋dense 回帰リスク事例あり） | 同 |

### bat 最終形

- `UBATCH` 既定 512→**2048**（PERF_ARGS に統合）
- `CT_K`/`CT_V` env 追加（既定空）→ `--cache-type-k/v`。Qwen3.8 運用は `q8_0`/`q8_0` を推奨
- sed -i で bat を編集すると LF 化する → 編集後 CRLF 正規化が必要（host test 前に確認）

### 最終検証値

| モデル | 構成 | tok/s |
| --- | --- | --- |
| Ornith-1.5-35B-A3B (AD-Q5_K-Q4_K) | thinking on/off, 131K ctx, ub2048, KV V q8_0 | **111.5 / 111.3** |
| Qwen3.8-27B (Q4_K_S) | draft-mtp, KV q8_0×2, 65K ctx, effort low | **62.9–68.6**（acceptance 88–96%）|

両モデルとも bat 経由起動・thinking 切替・コード生成品質を確認済み。settings 既定は Ornith（specType 空）。Qwen3.8 使用時のみ UI セレクトで draft-mtp + CT_K/V q8_0 を指定。

## 2026-08-22: 改善オプション3件のテストと導入判断

コミット a04ecfd（bat に MMPROJ_FILE 対応追加）。

| オプション | 結果 | 判断 |
| --- | --- | --- |
| Qwen3.8 を 128K ctx | draft-mtp+KV q8+ub2048 で 131072 スロット起動成功、68.0 tok/s 劣化なし | **採用**（設定値のみ、コード変更なし） |
| Ornith vision (mmproj) | mudler APEX の mmproj.gguf(0.9GB) が AtomicChat 本体と互換。「赤い円」正答。**thinking off 併用必須**（on だと max_tokens を思考で使い切り本文空） | **採用** — bat `MMPROJ_FILE` env 追加。Pi プロバイダの input は "text" 固定のままなので UI 添付は未配線（要望時に対応） |
| Ornith APEX-MTP-Compact spec decode | 96.8 tok/s / acceptance 92.5% → **現行 AtomicChat 版(111 tok/s)に届かず**。MoE A3B はアクティブ軽量のためドラフトヘッド相対コストが勝つ。品質レシートも現行(KLD実測)が上 | **不採用・17.4GB 削除** |

### 運用メモ

- vision 起動例: `set MMPROJ_FILE=Ornith-1.5-35B-A3B-GGUF\mmproj.gguf`（MODEL_DIR 相対）。router モードでは無効
- mmproj.gguf は `C:\Users\Daichi\models\llm\Ornith-1.5-35B-A3B-GGUF\` に配置済み
- テスト画像は PowerShell System.Drawing で生成可能（PNG 数百バイト）
- taskkill 直後の再起動は VRAM 解放待ちでヘルス待ちタイムアウトすることがある → sleep 15 以上推奨（2回目で判明）

## 2026-08-22: ローカルLLM設定 UI のユーザーフレンドリー化

コミット fa1ef5e。設定 → エンジン → ローカル LLM の改善。

### 潜在バグ修正（重要）

`effort: ""` が `LLAMA_SERVER_EFFORTS` に無く invalid 扱い → Ornith 用に保存した settings JSON が UI 表示・保存時に DEFAULT へフォールバックする潜在バグ。`""` を正式値（kwarg 省略 = 思考テンプレなしモデル用）として追加。

### UI 改善

- ラベル日本語化: 思考の深さ / 高速化（推測デコード）/ コンテキスト長 / 同時処理数
- モデル別推奨プリセット: `findLlamaModelPreset(modelFile)` — ornith→{effort:"",spec:"",131K}、qwen3.8/3.5系→{effort:"low",draft-mtp,131K}。不一致時に「推奨設定を適用」ボタン表示
- 危険組合せガード: `isLlamaSpecComboBroken` — MTP 非対応モデル+draft-mtp は赤警告+起動ボタン拒否
- コンテキスト長プリセットボタン 32K/64K/128K
- 注意: `bg-bg-strong`/`text-fg` はトークンに存在しない。surface 系（bg-surface-3 等）を使う

## 2026-08-22: モデルファミリードロップダウン＋詳細シェルフへ再構成

コミット 699a7b1。設定 → エンジン → ローカル LLM の UX を「プリセット選択が主、詳細は折りたたみ」へ。

### 構成

- **使用するモデル（ドロップダウン）**: `Ornith-1.5 35B（バランス）` / `Qwen3.8 27B（思考つき・高速）` / `カスタム（詳細設定）`。選択で modelFile（models 一覧からパターン検索）+ effort + specType + contextLength + cacheTypeK/V を一括適用
- **詳細設定シェルフ**: デフォルト折りたたみ。カスタム選択時は自動オープン。ヘッダに「カスタム値あり」バッジ（presetMismatched）。ChevronDown 回転
- specBroken 警告と起動ガードはシェルフ外に常時表示

### 配線追加

- settings schema に `cacheTypeK/cacheTypeV?: "" | "f16" | "q8_0"` 追加 → BFF route 検証 → host launcher `set CT_K/CT_V`
- bat の CACHE_ARGS を K/V 独立指定可能に変更（片方のみでも有効）
- プリセット: Ornith {effort:"",spec:"",131K,ctK:"",ctV:"q8_0"}、Qwen3.8 {effort:"low",draft-mtp,131K,q8_0,q8_0}
- `LLAMA_MODEL_PRESETS` に key フィールド追加（セレクト値）

### 検証

- vitest 326 passed / tsc OK / host test 75 passed

## 2026-08-22: モデルファミリー選択がカスタムに戻るバグ修正

コミット 83649e4。

### 原因（実測）

- settings JSON の `modelDir`/`modelFile` が空（前バグ期間中に UI 自動保存で DEFAULT が書き込まれた）
- dir 空 → `/api/llama-server/models` は `models: []` を返す仕様
- ファミリーセレクトの `familyKey` を **modelFile からの派生値**にしていたため、models 未取得状態では candidate 解決できず modelFile 不変 → 派生が常に「カスタム」に戻る

### 修正

1. models route: dir 空 → bat の `MODEL_DIR` 既定値へフォールバックして一覧返却（`batDefaultModelDir()`）
2. UI: `selectedFamily` state で選択を保持（modelFile 派生はフォールバック扱い）。models 到着後に effect で GGUF 解決。hydrate 完了時は selectedFamily=null（保存済み modelFile から派生）
3. loadModels 応答の解決済み dir で config.modelDir が空なら補完（自動保存される）

### 教訓

- セレクト等の選択 UI の表示状態を別データ（modelFile）の派生だけで決めると、依存データ未取得時に「選んだのに戻る」バグになる。選択意図は state 保持＋後から実体解決
- UI 自動保存は DEFAULT 値も平気で永続化する → 設定 JSON の破壊を疑うときはまず現物を見る

## 2026-08-22: mmproj.gguf がモデルとして起動されるバグ

コミット f85c722。models 一覧にビジョン投影器 `mmproj.gguf` が含まれ、ソート順（m < o）で Ornith 本体より先に現れるため、ファミリープリセット解決の candidate が mmproj を拾い alias「mmproj」で起動してヘルス待ちで止まる。

### 対策

- models route の collect で `/^mmproj/i` を除外（isMmProj）
- settings JSON の modelFile を Ornith 本体へ手動復旧

### 教訓

- モデルディレクトリ走査は「起動可能な本体 GGUF」だけを返す。補助ファイル（mmproj/imatrix/shard 続き等）は列挙段階で落とす

## 2026-08-22: 起動ヘルス待ちの自動リトライ追加

コミット b46df74。「Waiting...から進まない」報告（手元では即成功＝一時的要因： 直前プロセス kill 後の VRAM 解放遅延で llama-server がログ前に死亡）。

### 対策

bat を再構成: start 行を `:launch` ラベルに集約し、ヘルス待ち失敗時に `taskkill /IM llama-server.exe` + 20 秒待ち + **1 回だけ自動リトライ**（LAUNCH_RETRIED フラグ）。リトライ尽きで exit 3。

### 教訓

- 「ログに何も書かれていない死」は VRAM/ドライバ解放遅延を疑う。taskkill 後の再起動は sleep 15-20 秒推奨（3 回確認済み）

## 2026-08-22: Qwen thinking の反復ループ対策

コミット c3d0002。Qwen使用時に「別のファイルを見よう」「再読込しよう」といった思考が反復する症状を調査。

### 原因

- 単発の `reasoning_effort=low` API は正常で、モデル自体の常時ループではなかった。
- HomeView は現在のモデルが保存済み thinking level をサポートしない場合、`thinkingLevels[最後]`（Qwenでは xhigh）へ昇格していた。
- TaskViewのモデル切替もセッションの古いthinking levelを再クランプしていなかった。

### 修正

- 非対応levelは最も高いlevelではなく `off`（なければ最初の対応level）へ降格し、localStorageにも保存。
- `setTaskModel` 後に新モデルの対応levelへ必ず再クランプし、セッションへ反映。
- TaskView表示も未対応levelをそのまま表示しない。

### 検証

- Qwen実機 `reasoning_effort=low` は正常終了。
- vitest 331 passed / tsc OK / host test 75 passed / lint 0 errors（既存warning 6件）。

## 2026-08-22: タブバー表示時に composer が下に欠ける ＋ 送信が効かない

コミット 86c7853。ユーザー報告の2バグ。

### 原因

- **composer めり込み**: 58b7681（タブ機能）以降、ペイン `<section>`（flex-col, overflow-hidden）が TaskTabs（min-h-9 shrink-0 ≈41px）+ SplitTaskView（`h-full` = section の 100%）を並べたため、合計が section を 41px はみ出し composer 下端（ツールバー行＝送信ボタン含む）が丸ごとクリップされていた。single モード（タブバー無し）では再現しない。
- **送信されない**: curl で `POST /api/tasks/:id/prompt` を直接叩いて正常動作を確認。セッションファイルにユーザー追記も無く＝リクエスト自体が届いていない → フロント側で送信操作が成立していなかった。上記クリップで送信ボタンが視認・クリック不可なことに加え、IME composition 中にフォーカスを外すと compositionEnd が来ず `composingRef` が stuck true になり Ctrl+Enter も永久に無効化され得た。

### 修正

- TaskView ルートを `flex h-full flex-col` → `flex min-h-0 flex-1 flex-col`（タブバー分を除く残り高さに収める）。TaskPanesHost の dynamic loading プレースホルダも同じ修正
- Composer の textarea 型に onBlur を追加し、blur 時に composingRef を false に戻す

### 検証

- vitest 38 files / 326 tests、tsc --noEmit、eslint（変更ファイル）— 成功
- `node scripts/build-web.mjs --skip-guard` でミラー再ビルド → handOffToServedWebUi により稼働中 WebUI が新ビルドへ自動再起動（health 200 確認）
- 検証用スクラッチタスクは API `DELETE ?hard=1` で掃除済み

### 教訓

- ペイン section のような flex-col コンテナに「バー + h-full 本体」を積むと必ずバー分はみ出る。hidden mount 子には min-h-0 flex-1 を使う

## 思考翻訳機能の移植（2026-06-17）
- 本家 LeafCode から LeafCodePi へ移植完了（host: 7a6a23c, web: e009cef）
- Python環境は `py -3 translation/install.py --data-dir "%APPDATA%\leafcode-pi"` で初回のみ導入
- AI品質レビューパス（/api/translation/review）は oc-server/llama-direct 依存のため未移植。host側の unreviewed/review-results エンドポイントは配線済みなので、llama-server経由で後から追加可能
- webテストは happy-dom + @testing-library/react を devDependencies に追加して tsx テストに対応
- 導入ボタン追加（5ff6b7d）: host translation-service.install() が install.py をバックグラウンド実行、status().installState/installError をポーリング表示。設定「一般」タブの未導入時のみボタン出現
- 設定コンポーネントテスト追加（f89d4f4）。tsxテストは @vitest-environment happy-dom ディレクティブ方式
