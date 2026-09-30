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
2. Next非依存の実行層: **着手済み・未完**。下表のとおり、Next/SDK/アプリストアに依存しない判定・順序・保存をBackend coreへ移設し、Webは同名の互換入口（注入アダプター）にした。実測（2026-09-30時点）: `backend/core/` は**35モジュール・44テストファイル**、`backend/src/` は transport と起動アダプタの3ファイル（`server.mjs`・`entry.mjs`・`runtime-host.mjs`）。Backendテストは**385件成功**（重複プロセスのlease競合試験を含む。同試験は高負荷時にワーカー起動自体が失敗することがあり、起動失敗のみ再試行する）。Web側は**4339件成功・2件失敗**（既存の`/api/health`のdataDir、`MessageCardRadius`）と、MCP拡張の`typebox`未解決によるファイル単位の失敗1件で、いずれも本作業とは無関係。高負荷時にsubagents拡張の並行実行テストが失敗することがあるが、単独実行では成功する（負荷起因のフレーク）。移設済みモジュールはNext/Webをimportせずに読み込め（多くは別Nodeプロセスでの実行もテスト済み）、Backend側テストで挙動を固定している。ただし **Backendプロセスは実行経路に未接続** で、SDK・ストア・leaseの実体は従来どおりWebプロセス内にある（HTTP Backendのhealthは503/startingのまま）。

   | モジュール（`backend/core/`） | 移設した内容 | Webに残るもの |
   | --- | --- | --- |
   | `sdk-runtime.mjs` / `account-runtime-manager.mjs` | SDKのlazy/single-flightロード、モデルランタイム・セッション生成境界、アカウント別ランタイムのLRU管理 | harnessからのSDKローダー注入（identity維持） |
   | `app-store.mjs` | プロジェクト/タスクCRUD、`store.json` v1、キャッシュ、日次バックアップ | パス方針・workspace割当を注入する同期APIの入口 |
   | `app-paths.mjs` / `xdg-user-dirs.mjs` | データディレクトリ・`store.json`等のパス、パス比較、Documents/XDGの解決、無プロジェクトworkspace作成、テスト時のlive data保護ガード | `lib/paths.ts`・`lib/xdg-user-dirs.ts` は同名exportの互換入口 |
   | `bot-avatar.mjs` | Botアイコンの色パレット・形の語彙と描画データ、色の妥当性検証・ID由来の色決定・ランダム選択、インライン画像データの検証 | `lib/bot-avatar.ts` は同名exportの互換入口 |
   | `bot-config.mjs` | Bot設定の正規化（旧既定ツール一覧の一度きり移行、未知ツール名の保持、権限モードのfail-closed、skills/extraRootsの正規化、DTOビューのSOUL付与と未知ツール名の除外。ツール語彙は注入） | Botファイルのパス・読書き・タスク連携（store）・作成/更新/削除の副作用 |
   | `bot-store.mjs` | Botファイルのパス解決（bots/<id>配下のconfig.json・SOUL.md・MEMORY.md・workspace）と原子的な設定書込み、一覧・SOUL読書き・MEMORY初期化・SOULリビジョン・ディレクトリ削除 | タスク連携（insertBotTask/patchTask/deleteTask/listTasks）と作成/更新/削除の副作用 |
   | `bot-runtime-context.mjs` | 拡張の同一性判定（index.*はディレクトリ名、それ以外はステム）とLeafCode同梱判定、Botのモデル向けruntime context文字列の組立（ロード済み拡張をJSON行で列挙） | 拡張の探索・有効/無効状態（extensions.ts） |
   | `bot-crud.mjs` | 新規Bot設定の既定値生成と、パッチ適用のマージ規則（声のtrim/空で消去、目色の検証と自動への戻し、skillsの据え置き、soulの剥離、updatedAtの更新） | ファイル書込み・SOULファイル・タスク同期・ID生成と現在時刻 |
   | `bot-lifecycle.mjs` | Bot作成・更新・削除の副作用順序（workspace→SOUL→MEMORY→config→1:1タスク登録、config→SOUL→タスク項目同期、タスク後始末→ディレクトリ削除）と戻り値契約 | ファイル実体・タスク実体・ID生成・現在時刻 |
   | `bot-prompt-sources.mjs` | Botセッションのプロンプトソース順序（BOTS.md→USER.md→SOUL.md→MEMORY.md。存在するものだけ、SOULは常時、グローバルAGENTS.mdとグローバルSOUL.mdは除外） | グローバルパスの解決（agents-md）と存在確認 |
   | `task-runtime-lease.mjs` | lease取得/解放、heartbeat、孤立タスク照合と通知 | global token・listener・backlogの引継ぎ |
   | `restart-resume.mjs` / `runtime-startup.mjs` | 再起動復旧の再試行予算、起動順序（listener登録→孤立照合→relay→scheduler→Room照合） | 各起動サービスの実体、instrumentationの互換呼出 |
   | `pending-prompts.mjs` / `webui-bridge.mjs` | 質問/承認の待機キューとタイムアウト、ブリッジ受付口（globalThisの枠・未登録時null） | harnessのprocess-localシングルトン、拡張側コピー |
   | `prompt-control.mjs` | steer/followUp分岐、ストリーム待機、prompt世代、キュー破棄、思考必須エラー判定 | `live`セッション本体・prompt連鎖 |
   | `abort-control.mjs` / `abort-coordinator.mjs` | ユーザー停止とhang watchdog停止の副作用順序（副作用は注入） | Goal Loop・サブエージェント停止の実体、スナップショット配信 |
   | `live-lifecycle.mjs` / `live-replace.mjs` | dispose時のRoom busy・shutdown要否判定、置換時の旧live切離し順序（購読解除→旧アカウント参照の解放→旧セッション破棄→スナップショットタイマー取消）、attach時のアカウント決定と1:1 Bot liveのmailbox昇格判定（Roomは昇格しない）、extension shutdown→session disposeの順序とin-flight登録、ensure-live世代の照合と「登録済みliveが自分のattach結果か」の判定・in-flight ensureの登録/解除（新しい試行が置き換えたら古い側は消さない）・未接続セッションの破棄（session_shutdownは出さず例外は握りつぶす契約）・セッション生成直後/attach直後の扱い（世代が古ければ破棄して再試行、タスク消滅は404、attach結果が最新でなければ破棄しない）・in-flight ensureに合流した後の扱い（世代が古ければ採用せず再試行）、置換の共通末尾（永続化先行・失敗時の破棄と復元） | `live`のmap・購読・`attachSession`/`ensureLive`/`createSession` |
   | `live-attach-state.mjs` | attach時のlive初期状態（置換前liveのマップ/プロンプト連鎖/世代の引継ぎ、task由来の復元値、transcript由来のタイミング復元。versioned mapは注入） | transcript走査とversioned mapクラス、SOULリビジョン取得 |
   | `live-session-preflight.mjs` | liveセッション生成前の拒否理由の優先順位（task不在→archive済→他workerのlease）と、セッション設定の決定（Bot判定、workspace、sessionNameのBot名前空間、権限モードとskill permissionのフォールバック、セッションが使うアカウントの選択と明示アカウントの拒否理由） | エラー文言とHTTPステータス、通知などの副作用 |
   | `session-event-decisions.mjs` | セッションイベントごとの判定（agent_start/settled/endでの同期要否、自動コンパクション失敗の判定と記録メッセージ、transport復旧中のsettle抑止、task行が消えたイベントの破棄、agent_startのlease取得→working公開の順序） | イベント受信時の副作用の実体（タスク更新・状態遷移・スナップショット） |
   | `snapshot-schedule.mjs` | スナップショットの合流規則（非描画イベントの除外、高頻度イベントのdelta化、フル待機中のdelta破棄、100ms窓、発火時に読むpending内容）と、unsubscribe時の後始末順序（タイマー取消→pending消去→保留分のemit） | タイマー実体とSSE emit |
   | `session-identity.mjs` | セッションが報告する識別情報（sessionId/sessionFile/provider/model）の選択（タスクモデル保持時はtranscript位置のみ）と保存済みタスクとの差分計算、書き込む変化があるかの判定。欠落値で保存済みを消さない規則を含む | `lib/pi/session-identity.ts` は同名exportの互換入口 |
   | `routine-scheduler.mjs` | scheduler lock（stale時のみ再取得）、実行対象判定、切り離し起動 | ルーティン保存と実行本体 |
   | `directory-lock.mjs` | 複数workerで共有するロックディレクトリの同期ロック（stale回収・待機上限・busy通知。rooms/routinesが共用） | hang-watchdog・web-settings・pi-auth・model-throughput-stats・transfer-recoveryの個別ロック実装（待機間隔や非同期性が異なり未統合） |
   | `keyed-serializer.mjs` | キー（promotion先ディレクトリ等）ごとの直列化（前の保持者を待つ→実行→解放、置換された古い保持者はエントリを消さない、異なるキーは並行） | 対象キーの正規化と実行内容 |
   | `room-recovery.mjs` | 放置working発言の判定、handoff整理と再配信 | Room保存・実行 |
   | `room-normalize.mjs` | 保存済みRoom JSONの検証・正規化（不正なメッセージ/handoff/outcomeの破棄、メンバー重複除去、opt-inフラグ。handoff状態の語彙は共有DTO定数を注入） | Room読書き・書込み・イベント発火・Bot検証 |
   | `room-store.mjs` | Roomファイルの読書き（原子的tmp+rename、ID検証、更新日時降順の一覧、書込後の通知フック）、データディレクトリの解決、live上限を超えた発言のhistory.jsonlへの追記、画像・添付のパス検証と読出、relay状態（relay.json）の読書き、relay envelopeの発行・消費（深さ上限・TTL・consumed・claimsによる重複参加の拒否） | ルート解決（dataDir配下）とprocess-localなイベントバスの実体 |
   | `room-relay.mjs` | relay envelopeの発行・消費（深さ上限3、TTL10分、consumed、親envelopeの検証、claimsと既参加ターンによるfan-out拒否、room lock下の原子的クレーム） | 部屋とBotの実体・ロック・時計・UUID |
   | `bot-code-report.mjs` | Bot向けCode結果報告プロンプトの組立 | Room用前置きプロンプトの生成 |

   修正済み: `createBotConfig` は `skills` の `include`/`exclude` を独立コピーする（移設時に発見した浅いコピーは、1つのBotのskills変更が `DEFAULT_SKILLS` と以後のBotへ波及し得たため、テストで固定したうえでコピーに修正）。**未完（実切替前に必要）**: `live`セッションの所有と`attachSession`/`ensureLive`、スナップショット配信、Goal Loop・サブエージェント停止の実体、Bot intercom、各起動サービスの実装、他の業務ストア、待機要求の内部API化（Web再接続時にBackendのpending snapshotを取得して再表示する経路。getTaskDetail・SSE snapshot・attention一覧はすでに同じメモリ上のpendingを返すので、Backend内に限れば再表示は成立している）。同一IDの待機中再送の合流と別セッションとのID衝突の拒否はpending-promptsで実装済み。待機要求のディスク永続化は行わない方針とする（根拠: 待機は SDK のツール呼び出しがプロセス内で await しているため、Backend再起動後に保存済みの要求を復元しても応答先がない。再起動時は孤立タスク照合でerrorになりrestart-resumeが扱う。この前提はセッションをBackendプロセス内に置く限り成り立つ）。WebUI切断中もBackend側の5分タイムアウトは進み、期限後は拒否扱いとなる（従来のブラウザを閉じた場合と同じ）、ブリッジのプロセス間化（現状はプロセス内globalThis）、期限切れleaseの再取得は、複数プロセス競合で旧実装が二重所有（5並列中4つが取得成功）を起こすことを実測した。per-task reclaim lock（再検証付き・10秒でstale回収）で直列化し、同条件で1所有者になることを複数Nodeプロセス試験で確認した。ただしreclaim lock未対応の旧ビルドが同じ`task-leases`を触る間は旧競合が残り、実切替時は旧経路を停止してから切り替える。reclaim lockを残したcrashed holderは10秒で回収する。lock取得に負けた側が一時的に「実行中」と返す挙動は許容仕様。Backend起動アダプタの前提: `backend/src/runtime-host.mjs` に、共通startupの完了後だけreadyになり、失敗・停止時はreadyにならない状態機械（失敗は再試行可、停止は永続、例外本文は出さない）を追加した。`entry.mjs` にはまだ接続せず、healthは503/startingのまま。接続には、startupの各サービスがWeb専用モジュールに依存している点の解消が先に必要: パス解決（`lib/paths.ts` のdataDir・storePath・workspace割当・path同一性）、Bot/Roomストア、`harness`（promptTask・startBotCodeRelay）、ルーティン実行本体。現状でWeb非依存に組み立てられるのはleaseとアプリストアで、そのパス解決（`app-paths.mjs`・`xdg-user-dirs.mjs`）はcoreへ移設済み。Bot/Roomストア、`harness`依存部、ルーティン実行本体のWeb非依存化が残る。全体のWeb型検証は、拡張（`leafcode-goal-loop`/`loop-guard`）が `@earendil-works/pi-coding-agent` を解決できず既存から失敗しており、本番用 `tsconfig.build.json` の型検証で代替している。
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

本ループ（ターン21〜50）で追加した移設: 期限内leaseの二重所有修正（reclaim lock）、待機要求の冪等受付と永続化しない方針、Backendのreadiness状態機械、アプリのパス解決、同期ディレクトリロック、キー単位直列化、Roomの正規化・ファイル読書き・履歴追記・画像/添付・relay状態とenvelope、Botのアイコン語彙・設定正規化・ファイル層・既定値/パッチ・副作用順序・runtime context・プロンプトソース、liveのattach初期状態・切離し順序・mailbox昇格・遅延shutdown・in-flight管理・世代照合・生成/attach直後の扱い・未接続セッション破棄、セッションイベント判定とスナップショット合流・購読解除時の後始末、セッション識別と識別差分、liveセッション生成前の拒否順序と設定決定。 期限内leaseの二重所有修正（reclaim lock）、待機要求の冪等受付と永続化しない方針の明文化、Backendのreadiness状態機械、アプリのパス解決、同期ディレクトリロック、Roomの正規化・ファイル読書き・履歴追記・画像/添付・relay状態とenvelope、Botのアイコン語彙・設定正規化・ファイル層・既定値/パッチ・副作用順序・runtime context・プロンプトソース。いずれもWeb側の互換入口を残し、Backendテストで挙動を固定した。ただし **分離完了は主張しない**。Backendプロセスは依然として実行経路に未接続（healthは503/starting）で、稼働中WebUIやGoal Loopの再起動も行っていない。実切替は「段階3以降（独立API・Web中継、Host分離、旧経路撤去）」を終えた後に行う。
