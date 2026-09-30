# WebUI / Pi SDK のプロセス分離

## 目標

`host` が Next.js と独立した Node.js Backend を監視する。Pi SDK は Backend 内で使用し、CLI RPC への置換は行わない。WebUI の再起動・ビルド・接続切断でエージェントを止めない。

## 責務

- WebUI: UI・外部認証・既存 `/api/...` の中継。SDK の起動、業務データの更新、定期実行は禁止。
- Backend: セッション、Goal Loop、Bot/Room、定期実行、質問/承認待ち、OAuth、履歴投影、アプリデータ更新。
- Host: 両プロセスの独立起動・監視・再起動、トレイ、既存の llama-server 制御。
- `shared/`: ブラウザへ秘密情報を渡さない通信契約とDTO。

## 内部通信 v1（今回の実装）

- HTTP の待受は `127.0.0.1` に固定。既定ポート18776。
- `LEAFCODE_PI_BACKEND_PORT` で変更可。0はOSによる空きポート選択。
- 全リクエストで `Authorization: Bearer <internal-token>` が必要。
- 内部トークンは `LEAFCODE_PI_BACKEND_TOKEN` に渡す。32〜512文字の空白を含まないASCII。公開WebUIの認証情報とは別物。
- Host統合時は起動世代ごとに暗号学的乱数で生成し、子プロセスへ渡す。設定ファイル・ブラウザ・ログに保存しない。
- トークンを検証した後、`x-leafcode-backend-protocol: 1` を検証。不一致・欠損は409。
- `GET /internal/health`: service、protocolVersion、instanceId、pid、startedAt、ready、status。
- socket起動とSDKのreadyを区別する。現時点ではSDK未接続のため503 / startingを返す。ランタイム初期化・復旧完了後だけ200 / ready。
- 認証失敗401、未知の経路404、非GET405。CORSを許可しない。例外の本文・認証値は応答やログへ出さない。
- `npm run backend` は単独の試験用起動。現行Host/WebUIからはまだ接続しない。

## 段階と現在地

1. 通信契約・依存境界: **進行中**。認証、版数、health、起動/停止を追加。既存のタスク・モデル・質問/承認・Bot/Room・履歴・Git等のDTOを `shared/types.ts` へ移動。既存 `@/lib/types` は互換再エクスポート。共有契約はNext/SDK/Node型への依存なしで単独型検証できる。設定等の個別ファイルにあるDTOと実行依存の抽出は後続。
2. Next非依存の実行層: **着手済み**。アカウント別ランタイムの所有・参照数・LRU管理を `backend/core/account-runtime-manager.mjs` へ移設し、Web側は互換入口にした。`backend/core/sdk-runtime.mjs` にSDKのlazy/single-flightロード、モデルランタイム生成、セッション生成の境界を追加。Backend側のSDKは移行時のWeb SDKと同じ0.87.1に固定しlockfileを持つ。実SDKを一時ストレージ・ネットワーク無効で初期化するテストを追加。harnessのSDKロード、既定/アカウント別ランタイム生成、セッション生成をこのファクトリへ接続済み。移行中はSDKローダーをharnessから注入し、既存のSDKモジュール・プロバイダー登録・テストのidentityを維持する。既定ランタイムは初期llama-serverプロバイダー登録成功後だけ公開し、その登録失敗時は未初期化として再試行する。再起動復旧を `backend/core/restart-resume.mjs` へ移設し、既存の `restart-resume.json` とプロンプト・再試行上限・除外判定を維持する。データディレクトリとタスク/実行コールバックは注入する。起動順序も `backend/core/runtime-startup.mjs` へ抽出し、復旧listener登録→孤立タスク照合→relay→scheduler→Room照合を共通化した。同時起動を集約し、起動失敗は再試行可能。履歴/モデルwarmupと遅延ラベル補完は非必須で、待たずに起動を終える。Web instrumentationはNode/Edge判定と互換アダプターの呼出だけにした。タスクleaseの取得/解放・heartbeat・孤立タスク照合/通知も `backend/core/task-runtime-lease.mjs` へ移設した。保存先・ストア操作・時計・PID生存確認・timerは注入できる。ファイル名とレコード形式、取得上限、stale期限、通知backlog上限は維持し、Web互換入口は移設前のglobal token/ownedTasks/timer/listener/backlogを引き継ぐ。単独Nodeプロセス間の競合と死んだ所有者からの復旧を一時ストレージで検証する。プロジェクト/タスクのCRUDとJSON読書き・キャッシュ・日次バックアップを `backend/core/app-store.mjs` へ移設した。保存先・workspace割当・path同一性・名称・時計・UUIDは注入し、公開型は共有DTOを参照する。`store.json` v1、7日分の初回スナップショット、mtime/sizeキャッシュ、同一値patchの書込省略、単調増加updatedAtとメタデータ更新の例外を維持する。Web storeは同名の同期APIとmodule-localキャッシュ寿命を持つ互換入口にした。質問/承認の待機キュー（先頭のみ表示・先頭のみ5分タイムアウト・中断/破棄は拒否扱い）を `backend/core/pending-prompts.mjs` へ移設し、状態・timer・emit・セッション解決をインスタンス所有と注入にした。Webの互換入口とharnessのprocess-localシングルトンは維持する。WebUIブリッジ受付口（`requestWebUiPermission`/`requestWebUiQuestion`）も `backend/core/webui-bridge.mjs` へ移設し、globalThisのハンドラー枠（拡張側コピーと同一キー）・未登録時null・ID生成・要求形状を維持した。拡張側コピーとのキー一致は試験で固定し、拡張はBackend coreをimportしない。プロセス内globalThisのままなので、別プロセスのBackendへ切り替える際は内部通信への置換が必要。prompt制御の純粋な規則（steer/followUpの分岐・ストリーム待機・prompt世代・キュー破棄・思考必須エラー判定）は `backend/core/prompt-control.mjs` へ移設し、harnessは同名exportを維持する。`live`セッションの所有、ユーザー停止の順序（`backend/core/abort-coordinator.mjs`。副作用は注入し、順序・404・Room flush・例外伝播をテストで固定）と最終assistant id判定・Room判定・hang watch置換判定（`abort-control.mjs`）は移設済みで、hang watchdog停止（`runHangWatchdogAbort`。watch保持・Goal Loop非停止・hang_abort先行配信・watch置換時の早期returnをテストで固定）も同じ調整器へ移設済み。dispose時のRoom busy判定とshutdown要否判定は `backend/core/live-lifecycle.mjs` へ移設し、`live`のmap・購読・dispose副作用は harness に残る。セッション置換の共通末尾(永続化先行・失敗時の破棄と同一アイデンティティ復元) は `backend/core/live-replace.mjs` の `attachReplacementSession` へ移設済み。route/agent/SOULの置換が共用する。永続化例外時に未接続セッションを破棄しない既存挙動も維持している。attach時のアカウント決定（明示セッションアカウント優先・保持済み参照は二重取得しない）と1:1 Bot判定も `backend/core/live-lifecycle.mjs` へ移設した。Goal Loop/サブエージェント停止、スナップショット配信は harness に残り、移設は未完。ルーティン定期実行のscheduler lock（stale時のみ再取得）・実行対象の判定・切り離し起動は `backend/core/routine-scheduler.mjs` へ移設し、ルーティン保存と実行本体は Web に残る。各起動サービス・他の業務ストアの移設も未完。待機要求の永続化、リクエストIDの重複拒否、Backend再起動を跨ぐ再表示は未実装で、実切替前に必要。
3. 独立API・Web中継: 未着手。既存URLと応答形式を維持。切替は排他的に行い、旧経路とBackendの二重実行/書込を禁止。
4. Host・ビルド・再起動分離: 未着手。ready確認、独立した再起動予算、稼働中SDK/拡張世代の固定、互換性確認を追加。
5. 段階導入・旧経路撤去: 未着手。実プロセス継続試験後にSDK依存とシングルトンをWebUIから除去。

## API境界の棚卸し（2026-09-30、146 route.ts）

| API群 | 移設先・主な依存 |
| --- | --- |
| tasks / projects / models / providers / provider-models / accounts | Backend。harness、ストア、履歴投影、OAuth、モデル選択 |
| bots / bots/rooms / routines | Backend。セッション、Room実行、Bot relay、定期実行、イベント |
| settings / agents / skills / extensions / MCP / 指示Markdown | Backend。設定・ファイル更新、拡張ブリッジ、ライブセッション再読込 |
| git / diff / browse / workspace files / memory / usage / notifications / TTS | Backend。ホスト上のファイル・子プロセス・資格情報・外部通信 |
| auth/webui | WebUIに残す外部認証境界。内部トークンとは分離 |
| build-info | WebUI配信世代を返すためWebUIに残す |
| host / llama-server / translation | 既存Host制御APIとの連携。SDK依存・設定更新がある部分はBackendへ移す |
| host-probe | ローカルクライアント判定の意味を維持し、プロキシ越しの接続元を検証する |

共有契約のproductionビルドは、checkoutの `shared/` を **各Webビルドミラー内の `shared/`** にコピーする。親ディレクトリへの共用コピーやハードリンクは作らない。開発・テスト・ビルドで `@shared/*` を解決し、共有契約の更新もビルド更新判定に含める。今回も実行経路は切り替えない。

## 後続で必要な通信仕様

- イベント世代ID/連番、再接続と欠落時のsnapshot、遅いクライアントのバッファ上限。
- pending質問/承認の再表示。接続切断は購読解除だけで、実行停止は明示APIのみ。
- 副作用を伴う要求のID・重複受付防止。応答喪失時に無条件で再実行しない。
- アプリデータはBackend単一writer。Host固有設定はHost所有のまま。
- 抽出したアプリストアは既存の固定tmpファイル・mtime/size条件・可変キャッシュ行を維持する。多writerトランザクションや書込失敗時のメモリrollbackは追加していない。実切替ではBackend単一writerを排他的に成立させる。
- 抽出したleaseのstale判定は既存どおりPID・heartbeat/mtime期限による。実切替時の排他的所有や世代フェンシングを保証するものではなく、期限切れ競合・二重起動を別途検証/強化する。
- Backend障害時の復旧はWebUI再接続と区別。ツールの副作用は完全再開を保証しない。
- rollbackもBackend停止後に旧経路へ切替。実行中世代のファイルは更新しない。

## 完了の証拠

- 生成・ツール・Goal Loop中のWebUI再起動でBackend PIDと実行が維持される。
- WebUI停止中もBot定期実行、Room、サブエージェントが継続する。
- 再接続で履歴・進捗・質問・承認待ちが復元される。
- 通信断/再送でpromptや定期実行が二重実行されない。
- Backend停止をWebUIが検知し、再起動は上限を持つ。
- UI更新でBackendのSDK/拡張/依存関係を変更しない。
- 無認証・互換性不一致の内部要求は拒否される。

Backend単独のSDK検証前には `npm --prefix backend ci --ignore-scripts` で専用依存を用意する。実SDKテストはauth・models設定・models storeをすべて一時ディレクトリに限定し、モデルのネットワーク更新と起動時refreshを無効にする。既存ユーザー設定・資格情報・実セッションには接続しない。

移行中のWeb互換入口は `@backend-core/*` を参照するため、productionミラー内の `backend-core/` へcoreソースだけを独立コピーする。Backendの依存関係・サーバー・稼働ディレクトリはコピーしない。core更新も一時的にWebのビルド更新判定へ含め、Webからのruntime import撤去時に外す。HTTP BackendへはまだSDKや起動アダプターを接続せず、healthは503/startingのまま。共通startupの完了はSDK/Backendのreadyではない。移行中はWebのプロセス内singletonが起動アダプターを所有し、Backendとの二重起動を行わない。

今回の抽出では以上の分離完了を主張しない。稼働中WebUIやGoal Loopの再起動も行わない。
