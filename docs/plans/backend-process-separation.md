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
2. Next非依存の実行層: **着手済み・未完**。下表のとおり、Next/SDK/アプリストアに依存しない判定・順序・保存をBackend coreへ移設し、Webは同名の互換入口（注入アダプター）にした。移設済みモジュールはNext/Webをimportせずに読み込め（多くは別Nodeプロセスでの実行もテスト済み）、Backend側テストで挙動を固定している。ただし **Backendプロセスは実行経路に未接続** で、SDK・ストア・leaseの実体は従来どおりWebプロセス内にある（HTTP Backendのhealthは503/startingのまま）。

   | モジュール（`backend/core/`） | 移設した内容 | Webに残るもの |
   | --- | --- | --- |
   | `sdk-runtime.mjs` / `account-runtime-manager.mjs` | SDKのlazy/single-flightロード、モデルランタイム・セッション生成境界、アカウント別ランタイムのLRU管理 | harnessからのSDKローダー注入（identity維持） |
   | `app-store.mjs` | プロジェクト/タスクCRUD、`store.json` v1、キャッシュ、日次バックアップ | パス方針・workspace割当を注入する同期APIの入口 |
   | `task-runtime-lease.mjs` | lease取得/解放、heartbeat、孤立タスク照合と通知 | global token・listener・backlogの引継ぎ |
   | `restart-resume.mjs` / `runtime-startup.mjs` | 再起動復旧の再試行予算、起動順序（listener登録→孤立照合→relay→scheduler→Room照合） | 各起動サービスの実体、instrumentationの互換呼出 |
   | `pending-prompts.mjs` / `webui-bridge.mjs` | 質問/承認の待機キューとタイムアウト、ブリッジ受付口（globalThisの枠・未登録時null） | harnessのprocess-localシングルトン、拡張側コピー |
   | `prompt-control.mjs` | steer/followUp分岐、ストリーム待機、prompt世代、キュー破棄、思考必須エラー判定 | `live`セッション本体・prompt連鎖 |
   | `abort-control.mjs` / `abort-coordinator.mjs` | ユーザー停止とhang watchdog停止の副作用順序（副作用は注入） | Goal Loop・サブエージェント停止の実体、スナップショット配信 |
   | `live-lifecycle.mjs` / `live-replace.mjs` | dispose時のRoom busy・shutdown要否判定、attach時のアカウント決定、置換の共通末尾（永続化先行・失敗時の破棄と復元） | `live`のmap・購読・`attachSession`/`ensureLive`/`createSession` |
   | `routine-scheduler.mjs` | scheduler lock（stale時のみ再取得）、実行対象判定、切り離し起動 | ルーティン保存と実行本体 |
   | `room-recovery.mjs` | 放置working発言の判定、handoff整理と再配信 | Room保存・実行 |
   | `bot-code-report.mjs` | Bot向けCode結果報告プロンプトの組立 | Room用前置きプロンプトの生成 |

   **未完（実切替前に必要）**: `live`セッションの所有と`attachSession`/`ensureLive`、スナップショット配信、Goal Loop・サブエージェント停止の実体、Bot intercom、各起動サービスの実装、他の業務ストア、待機要求の永続化・リクエストID重複拒否・Backend再起動を跨ぐ再表示、ブリッジのプロセス間化（現状はプロセス内globalThis）、期限切れleaseの再取得は、複数プロセス競合で旧実装が二重所有（5並列中4つが取得成功）を起こすことを実測した。per-task reclaim lock（再検証付き・10秒でstale回収）で直列化し、同条件で1所有者になることを複数Nodeプロセス試験で確認した。ただしreclaim lock未対応の旧ビルドが同じ`task-leases`を触る間は旧競合が残り、実切替時は旧経路を停止してから切り替える。reclaim lockを残したcrashed holderは10秒で回収する。lock取得に負けた側が一時的に「実行中」と返す挙動は許容仕様。全体のWeb型検証は、拡張（`leafcode-goal-loop`/`loop-guard`）が `@earendil-works/pi-coding-agent` を解決できず既存から失敗しており、本番用 `tsconfig.build.json` の型検証で代替している。
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
- 抽出したleaseのstale判定は既存どおりPID・heartbeat/mtime期限による。期限切れleaseの再取得はper-task reclaim lockで直列化済み（複数Node試験で1所有者を確認）だが、世代フェンシングや旧ビルドとの共存は保証しない。二重起動防止は実切替時に旧経路を止めて別途検証する。
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
