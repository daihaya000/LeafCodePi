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

実装フェーズ（残作業の実行順。各フェーズは独立してレビュー・検証する）:

- **Phase 1 実行体のWeb非依存化**: `promptTask`経路、Botコードrelay、Room会話実行、ルーティン実行本体をcore＋注入へ分解し、Backend単体で1往復できるようにする。
- **Phase 2 起動列とready化**: 起動列を`entry.mjs`へ接続し、完了後のみhealthを200にする。
- **Phase 3 内部APIとWeb中継**: 主要エンドポイントをBackend所有にし、Webは同一URLで中継する。
- **Phase 4 Host・ビルド・再起動分離**: Host側の起動/停止/ready確認、稼働中世代の固定、成果物分離。
- **Phase 5 実切替**: 旧経路停止→Backend起動→ready確認→中継有効化。ロールバック手順を検証する。
- **Phase 6 旧経路撤去**: 互換入口・プロセス内singleton・旧実装を削除し、未完欄を空にする。

現在地（ターン51時点の実測。ターン50までは上記の棚卸し済み）: **Phase 1 未完・Phase 2〜6 未着手**。`backend/core/` は48モジュール・60テストファイル、`backend/src/` は `server.mjs`・`entry.mjs`・`runtime-host.mjs`・`startup.mjs`（各テスト付き）、Backendテストは646件成功。Backendのhealthは**503/starting**のまま（起動プロセス単体で再実測）で、SDK・ストア・leaseの実体はWebプロセス内にある。ターン11〜50で追加したcore: `prompt-markers.mjs`（プロンプト内部マーカー）、`task-detail.mjs`（詳細の読み出し元・フラグ・タイムアウト・compaction提案）、`attention.mjs`（待機要求の所有キー・項目形・クリア対象・通知先）、`bot-code-request.mjs`（Botコード要求の入力契約・開始前検証・レコード組み立て・結果取り込み・配信ゲート・スキャン契約・Roomターン選択・監督条件・レポート検出）。併せて既存coreへ追記した範囲: prompt送信ゲート・選択適用・送信種別・reasoningフォールバック・再ルーティング・hang-watch・遅延リロード・保留設定の適用/消込・Goal Loopコマンドの制御と巻き戻し・ルーティン失敗時の自動無効化・webui-bridgeのプロセス内共有・状態変更イベントpayload。**ターン51で追加**: `scripts/build-backend-runtime.mjs`（Web/harnessをesbuildで単一ESMへバンドルし、`backend/runtime/runtime.bundle.mjs`を生成。`@`・`@backend-core`・`@shared`を解決、Pi SDKはexternal）と`web/src/lib/pi/backend-runtime-entry.ts`（Backendが必要とする11の実行APIのみ再export）。Backendのplain Nodeプロセスからbundleをimportでき、`npm run build:backend-runtime`で再生成、`backend/src/runtime-bundle.test.mjs`がAPI面を検証（bundle未生成時はskip）。bundled CJS依存の`require`はcreateRequireシムで解決。生成物はgitignore。
**ターン52の実測**: Backendのplain Nodeプロセスで、一時データディレクトリ（`LEAFCODE_PI_DATA_DIR`＋`NODE_ENV=test`）に対し
bundleの`getTaskDetail(id,{offline:true})`がタスク詳細を返し、存在しないIDは404で拒否されることをテストで固定（`backend/src/runtime-store.test.mjs`、3件）。
さらに手動プローブで`promptTask`が**セッションを生成して`status: working`を返す**ところまで到達した（`[LeafCodePi] pi-commandcode-provider is not installed`の警告のみ）。
モデル/認証はグローバルなpiエージェント設定を使うため、このプローブは実資格情報で1回だけ小さなプロンプトを送る。実行後はセッションをabort/disposeしないとプロセスが終了しない。
→ **BackendプロセスがSDKセッションを生成して1往復を開始できる**ことが実証できた（Phase 1の主要な障害は解消）。**ターン53で追加**: `backend/src/runtime-loader.mjs`（bundleの遅延読込。未生成=missing・古いentry=incomplete・import失敗=unavailableを返し、例外文は出さない）と、coreの`RuntimeStartup`への`loadRuntime`任意ステップ（起動列の**先頭**で実行し、失敗時は後続を実行せず呼び出し側の再試行に委ねる）。`createBackendStartup`は`loadRuntime`を注入されたときだけruntimeを接続し、`runtimeStatus()`で`{ok,reason}`（既定は`not-requested`）を公開する。**ターン54で接続**: `entry.mjs`が`LEAFCODE_PI_BACKEND_RUNTIME`（1/true/yes/attach）でruntime接続を要求されたときだけ
bundleを読み込み、`runtime-host`のreadyと`runtimeStatus().ok`の**両方**が真のときだけhealthを200にする（既定は無効＝従来どおり503/starting）。
bundleパスは`LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE`で差し替え可能。CLIテストで「無効=503」「有効かつbundle有り=200（attach完了を待つ）」「bundle欠落=503のまま（パスをechoしない）」の3通りを固定。
**ターン55で追加**: 内部API `GET /internal/tasks`（Backend自身のstoreビュー＝保存された行そのもの）と `GET /internal/tasks/:id`（無ければ404）。認証・プロトコルヘッダ・GETのみという既存規則を踏襲し、store読取の失敗は500へ封じ込めてパスを漏らさない。`entry.mjs`は起動列が持つstoreを注入する。Web側の中継は未接続（派生フィールドはWeb側に残る）。
**ターン56で追加**: `web/src/lib/backend-client.ts`（サーバー専用の内部クライアント）。トークンはサーバーenvのみから読み（`backendClientStatus`が`configured`を返す）、`fetchBackendJson`はprotocolヘッダ＋bearerを付けて、not-configured／unreachable／timeout／unauthorized／incompatible／bad-responseを区別して返す（例外文は返さない）。`readBackendHealth`・`readBackendTasks`は薄いラッパー。既存routeは切り替えていない（切替前）。
**ターン57で追加**: 診断用route `GET /api/backend/status`。WebUIの認証ゲート配下で、未設定なら`{configured:false,url,backend:null}`、設定済みならBackendのhealth要約（`{reachable,ready,status}`または失敗理由）を返す。トークンとpidはブラウザ可視の契約に含めない。
**ターン58で追加**: 内部API `GET /internal/tasks/:id/detail`。runtime未接続時は**503 `BACKEND_RUNTIME_UNAVAILABLE`**（タスクIDは返さない）、接続済みならbundleの`getTaskDetail(id,{offline:true})`の結果を`{detail}`で返す。404は404、その他の例外は500へ封じ込め（例外文は出さない）。`createBackendStartup`に`runtime()`アクセサを追加し、`entry.mjs`は接続済みのときだけ詳細ハンドラを渡す。
**ターン59で追加**: 中継route `GET /api/backend/tasks`（読み取り専用）。Backend未設定または到達不能なら**503＋理由**（`not-configured`／`unreachable`／`timeout`／`unauthorized`／`incompatible`／`bad-response`）を返し、黙ってプロセス内ストアへフォールバックしない。成功時は`{source:"backend", tasks}`。WebUI認証ゲート配下。既存の`/api/tasks`（派生フィールド付き）は**未切替**。
**ターン60で追加**: 中継スイッチ `LEAFCODE_PI_BACKEND_RELAY`（既定オフ）と `web/src/lib/backend-relay.ts`。有効時は `/api/tasks` の**生レコード経路**（`?titles=1`・`?paneCandidates=1`）だけがBackendの行を使い、形は同じ（保存行そのもの）。派生フィールドを持つ summary 経路と `?attention=1` は中継しない。Backendが答えられない場合は従来のプロセス内経路へフォールバックする（切替前の安全網。最終段階で旧経路と共に撤去）。
**ターン61で移動**: Botツール語彙（`BOT_TOOL_NAMES`・`BOT_DEFAULT_DISABLED_TOOL_NAMES`・`BOT_DEFAULT_TOOL_NAMES`）を `shared/bot-tools.mjs`（＋`.d.mts`）へ移し、`shared/types.ts`は`BotToolName`型を保ったままそこから再export。BackendプロセスがTypeScriptを経由せず同じ語彙を読めるようにするための前提。語彙の内容は変えていない（`shared/bot-tools.test.mjs`で固定）。
**ターン62で追加**: 内部API `GET /internal/bots`（Backend自身のBotストアビュー＝Webと同じ`bots/<id>/config.json`を読む）と `GET /internal/bots/:id`（未知は404）。語彙は`shared/bot-tools.mjs`から取り、`toBotDto`で**このビルドが知るツール名だけ**を公開する。`createBackendStartup`に`bots.list()`／`bots.get(id)`を追加し（不正なBot IDは例外にせずnull）、`entry.mjs`がそれらを注入。BotストアのID形式（UUID）と設定ファイルの正規化はcoreの検証をそのまま使う。
**ターン63で追加**: 稼働数ルール（`working`のみ・`botId`優先）を`backend/core/bot-session-counts.mjs`（`botCodeSessionCounts`／`botsWithCodeSessionCounts`）へ移し、Webの`/api/bots`とBackend中継が同じ数え方をするようにした。`backend-relay.ts`に`relayBotList`（中継オフ／Backend失敗時は`null`でフォールバック）を追加し、`GET /api/bots`は中継有効時にBackendのBotビュー＋稼働数を返す。既定は従来どおりプロセス内。
**ターン64で追加（Phase 4の一部）**: `runtime-host.mjs`に再起動予算（`maxRestarts`／`restartWindowMs`、窓外は数えない）と世代固定（`generation`／`setGeneration`／`generationInfo`、`allowGenerationChange`なしの世代差し替えは拒否）を追加。`runtime-loader.mjs`はバンドルの内容ハッシュから`generation`（16桁hex）を返し（読めない場合はnull）、`/internal/health`は`runtimeGeneration`を返すので、WebUIは稼働中Backendが自分のビルドと異なる世代か検出できる。`entry.mjs`はattach完了時に世代を固定する。再起動APIの実接続と互換性判定は未着手。
**ターン65で追加**: 互換性判定。`LEAFCODE_PI_BACKEND_GENERATION`（Hostが起動時に固定した世代）と`/internal/health`の`runtimeGeneration`を`isBackendGenerationCompatible`で比較し、中継（`relayTaskRows`／`relayBotList`）は世代不一致ならBackendを使わず従来経路へフォールバックする（判定は5秒キャッシュ）。未固定（Hostが記録していない）ときは比較対象が無いので互換扱い、世代不明のBackendは不一致扱い。`/api/backend/status`は`generation`（expected／running／matches）を診断表示する。
**ターン66で追加**: 世代の規則を`shared/backend-generation.mjs`（`normalizeExpectedGeneration`／`isBackendGenerationCompatible`／`runtimeGenerationStatus`）へ移し、WebとBackendが同じ判定を使うようにした。Backendは`LEAFCODE_PI_BACKEND_GENERATION`（Hostが起動時に固定した世代）と自分のバンドル世代を比較し、**不一致ならattach後もreadyにならない**（healthは503のまま`runtimeGeneration`と`runtimeGenerationPinned`を返す）。実測: 実バンドル＋一時データディレクトリで、不一致のpin→503（runtimeはattach済み）、一致のpin→200を確認。
**ターン67で追加（Phase 4・Host側）**: `host/src/backend-launch.js`にBackend起動プラン（`bundleGeneration`＝バンドル内容ハッシュ、`backendLaunchPlan`＝entryパス・token・port・runtime attach可否・pinする世代、`backendClientEnv`＝WebUI子プロセスへ渡す到達情報と期待世代）を追加。既定は`detached`（WebがSDKを所有している間はBackendへruntimeをattachしない＝二重writer防止）で、attachは明示時のみ。実測: Hostが算出した世代がBackendのローダーの世代（d3f72f1088c3730c）と一致。実プロセスの起動配線は実切替時に行う。
**ターン68で追加（Phase 4・Host側）**: `host/src/backend-service.js`にBackend子プロセスのライフサイクル（`isBackendRequested`＝`LEAFCODE_PI_BACKEND`で明示オプトイン、`createBackendService`＝spawn/停止/状態、独自の再起動予算（既定3回・60秒安定で回復、失敗後は暗黙再起動しない）、WebUI子プロセスへ渡す`clientEnv`）を追加し、`host/src/index.js`へ配線（既定オフ＝`backendService`はnullで従来と同一挙動、有効時のみspawnWebと同じenvに到達情報を足してstart、終了時にstop）。runtimeは切替時までattachしない（二重writer防止）。
**ターン69で追加（Phase 5の前提）**: `backend/core/cutover-plan.mjs`に排他的切替の事前判定（`cutoverPreflight`）を追加。blockerコードは backend-not-configured／backend-unreachable／backend-not-ready／runtime-detached／generation-mismatch／another-owner／active-work／goal-loop-active／foreign-lease／mixed-ownership／relay-disabled。判定は純粋関数（health・稼働中タスク・Goal Loop数・lease所有者・所有権スイッチを注入）で、`/api/backend/status`が`cutover: {ok, blockers}`として診断表示する。
**ターン70で追加（Phase 5）**: `host/src/cutover.js`に段階遷移＋ロールバック（`CUTOVER_STAGES`＝check→stop-old-path→attach-backend→hand-over→done、`runCutover`は全効果を注入）を追加。順序は「事前判定→旧経路（WebUI）停止→Backendをruntime attachで起動しready待ち→WebUIをBackendのクライアントとして再起動（relay有効・非所有）」で、失敗時はロールバック（Backend停止→WebUIを所有側で再起動）。**切替中はWebUIが短時間停止する**がBackendは稼働し続ける（分離の狙い）。ロールバック中の失敗は例外にせず`error`で報告する。
**ターン71で追加（Phase 5）**: `host/src/backend-health.js`にHost側のhealth読取（`readBackendHealth`＝token＋プロトコルヘッダ付きGET、401/403/409/500/JSON破損/接続失敗を理由として返し例外にしない、世代一致は`shared/backend-generation.mjs`で判定）と`waitForBackendReady`（期限内ポーリング、token不正・プロトコル不一致は再試行せず即終了）を追加。Hostはリッスンソケットではなく「ready＋世代一致」を所有権の条件にする。
**ターン72で追加（Phase 5）**: `host/src/cutover-effects.js`で切替の各段階をHostの実体（`stopWeb`／`spawnWeb`／`backendService`／health読取）へ接続し、`backend-service.start({attachRuntime})`で「detached常駐→切替時にattach起動」を選べるようにした。`index.js`は`spawnWeb({ownership, relay})`で`LEAFCODE_PI_BACKEND_OWNS_RUNTIME`／`LEAFCODE_PI_BACKEND_RELAY`を子プロセスの環境として渡し、`LEAFCODE_PI_CUTOVER=1`の明示指定時のみ起動直後に切替を実行する（既定オフ＝挙動不変）。事前判定の実体（Goal Loop稼働の拒否）は未接続で、現状は常にokを返す。
**ターン73で追加（Phase 5）**: `cutoverPreflight`に`phase`（`start`＝切替開始前の判定／`verify`＝切替完了の判定）を導入。`start`は「Backendが到達可能か・他所有者がいないか・稼働中タスク／Goal Loop／他プロセスのleaseが無いか」だけを見て、ready・世代・所有権スイッチはattach段階（`verify`）で判定する。`host/src/cutover-preflight.js`はHost側の入力を集める（store.jsonのタスク、task-leases/*.jsonの所有者pid、WebUIの`/api/goal-loop/active`の件数、Backendのhealth）実装で、`index.js`の切替実行時に接続済み。読取はread-onlyで、壊れたファイル・読めないleaseは「不明＝拒否側」に倒す。
**ターン74で追加（Phase 5）**: `runCutover`に`verify`段階（任意）を追加。hand-over後に外部から確認し、不合格なら`{stage:"verify", reason:"verify-failed", blockers}`でロールバックする（WebUIは所有側・relay無効で再起動）。`createCutoverVerify`はBackendのhealth（ready＋世代一致）とWebUIの`/api/backend/status`の`cutover.ok`を両方確認し、statusが読めない場合は`webui-unreachable`として不合格にする（未確認の切替はロールバック）。`index.js`はWebUI認証トークン付きで接続済み。
**ターン75で追加（Phase 5・Web側の非所有モード）**: `web/src/lib/pi/runtime-ownership.ts`に所有権の判定を集約（`webOwnsRuntime`／`isBackendRuntimeHost`／`localRuntimeBlocked`／`RuntimeNotOwnedError`／`assertLocalRuntimeAllowed`）。`LEAFCODE_PI_BACKEND_OWNS_RUNTIME=1`のWebUIでは**ローカルセッション開始を拒否**する: harnessの`promptTask`は副作用の前に`assertLocalRuntimeAllowed()`で例外にし、`POST /api/tasks/[id]/prompt`はタスク読取の前に409（`code: RUNTIME_NOT_OWNED`）を返す。Backendプロセス自身（`LEAFCODE_PI_BACKEND_RUNTIME`あり）は決して拒否しない。`backend-relay.ts`の`webOwnsRuntime`はこのモジュールの再exportに変更（既定は所有＝従来挙動）。
**ターン76で追加（Phase 5）**: Backendに `POST /internal/tasks/:id/prompt` を追加（`BACKEND_TASK_PROMPT_SUFFIX`）。認証・プロトコルヘッダ必須、runtime未attachは503（`BACKEND_RUNTIME_UNAVAILABLE`＝**ローカルへフォールバックしない**）、空IDは404、GETは405、本文は32MB上限（超過413、空・壊れJSONは400）、例外本文は返さずstatusのみ伝える（500既定）。`entry.mjs`はruntimeの`promptTask(id, prompt, images, options)`へ転送する。Web側の転送は次の増分。
**ターン77で追加（Phase 5・Web側の転送）**: `backend-client.ts`に`postBackendJson`／`promptTaskOnBackend`を追加（GETとPOSTで送信・理由分類を共通化）。`backend-forward.ts`は転送本文を**runtimeが理解するフィールドだけ**に絞り（`prompt`/`images`/`files`/`model`/`thinkingLevel`/`agent`/`streamingBehavior`/`resume`）、`auto*`はWebUI側で解決する必要があるため非所有モードでは409（`AUTO_NOT_SUPPORTED`）で拒否する。非所有モードの`POST /api/tasks/[id]/prompt`はBackendへ転送し、成功は`{task}`、未設定は409（`RUNTIME_NOT_OWNED`）、その他は502（`BACKEND_FORWARD_FAILED`）で**ローカルへフォールバックしない**。
**ターン78で追加（Phase 5・読み取りの転送）**: `GET /api/tasks/[id]`（タスク詳細）を非所有モードではBackendの`GET /internal/tasks/:id/detail`（`BACKEND_TASK_DETAIL_SUFFIX`）から取得する。成功は`{task: detail}`、未設定は409（`RUNTIME_NOT_OWNED`）、その他は502（`BACKEND_FORWARD_FAILED`）で**ローカル読み取りへフォールバックしない**（所有していないセッションを読むと古い状態を最新として見せてしまうため）。所有モードでは従来どおりプロセス内の`getTaskDetailBounded`。
**ターン79で追加（Phase 5・履歴の転送）**: `GET /api/tasks/[id]/messages`も非所有モードではBackendのdetailから取得し、**同じページング規則**（`pageTaskMessages`）で組む。カーソル不正の400は従来どおり、未設定は409（`RUNTIME_NOT_OWNED`）、その他は502（`BACKEND_FORWARD_FAILED`）でローカル読み取りへフォールバックしない。所有モードは従来どおり`getTaskDetail(id, {offline:true})`。
**ターン80で追加（Phase 5・待機要求の回答）**: Backendに `POST /internal/tasks/:id/permission` と `POST /internal/tasks/:id/question`（`BACKEND_TASK_PERMISSION_SUFFIX`／`BACKEND_TASK_QUESTION_SUFFIX`）を追加。既存のPOST経路（prompt）を汎用化し、未attachは503、空IDは404、GETは405、本文不正は400、回答対象が既に無い場合は404（`not-found`）を返す。Web側は非所有モードでこれらの回答を転送し（`forwardPermissionAnswer`／`forwardQuestionAnswer`）、404は「既に待機していない」としてそのまま404、未設定は409（`RUNTIME_NOT_OWNED`）、その他は502（`BACKEND_FORWARD_FAILED`）で**ローカル回答へフォールバックしない**。所有モードは従来どおりプロセス内の`respondToPermissionPrompt`／`respondToQuestionPrompt`。
**ターン81で追加（Phase 5・停止の転送）**: runtimeバンドルのentryに`abortTaskIncludingColdGoalLoop`と`stopBotCodeTask`を追加（`REQUIRED_RUNTIME_EXPORTS`にも追加＝旧バンドルはincompleteとして拒否）し、Backendに `POST /internal/tasks/:id/abort`（`BACKEND_TASK_ABORT_SUFFIX`）を追加。本文は任意（`{botId}`があればBot所有のoutbox停止経路、無ければ通常abort）、停止対象が無ければ404、未attachは503、GETは405。Web側は非所有モードで`forwardTaskAbort`により転送し、404はそのまま404、未設定は409（`RUNTIME_NOT_OWNED`）、その他は502（`BACKEND_FORWARD_FAILED`）で**ローカルabortへフォールバックしない**。バンドルは再ビルド済み（世代 `bd3d66b604a25790`）。
**ターン82で追加（Phase 5・Botプロンプトの転送）**: 非所有モードの`POST /api/bots/[id]/prompt`は、BotタスクID（`bot:<id>`）をそのまま使って既存の`/internal/tasks/:id/prompt`へ転送する（同じharnessがBackendで動くためBot経路の判定も同一）。Goal Loop開始はWebUI側の解決（`goalLoopCommand`）が必要なため非所有モードでは409（`GOAL_LOOP_NOT_SUPPORTED`）で拒否し、未設定は409（`RUNTIME_NOT_OWNED`）、その他は502（`BACKEND_FORWARD_FAILED`）でローカル起動へフォールバックしない。
**ターン83で追加（Phase 6の前提を測定で固定）**: `web/src/lib/pi/runtime-ownership-coverage.test.ts`を追加。Webのrouteを走査し、**セッションを開始・停止・回答する呼出**（`promptTask`／`goalLoopCommand`／abort系／`respondTo*`／`getTaskDetail(Bounded)`／`ensureLive`／`subscribeTask`／`queueBotCodePrompt`／`runUserBotCodeRequest`）を持つrouteが、所有権ガードか転送を持つことを強制する。実測: **16 routeが該当・うち7がガード済み・9が未配線**（未配線は`LOCAL_ONLY_PENDING`に理由つきで列挙: bots/[id]/abort、bots/[id]/code-requests、bots/[id]/code-session、bots/[id]/events、bots/[id]/route、bots/rooms/[id]/code、bots/rooms/[id]/events、tasks/[id]/events、tasks/[id]/goal-loop）。コメント内の言及は除外し、未配線routeの新規追加とリストの陳腐化の両方を検知する。この9件の解消（＝旧経路撤去の完了条件）がPhase 6の残作業。
**ターン84**: 未配線の1件目を解消。非所有モードの`POST /api/bots/[id]/abort`はBotタスクID（`bot:<id>`）と`{botId}`で既存の`/internal/tasks/:id/abort`へ転送し、Bot所有のoutbox停止経路をBackend側で選ばせる。404はそのまま404、未設定は409（`RUNTIME_NOT_OWNED`）、その他は502（`BACKEND_FORWARD_FAILED`）でローカルabortへフォールバックしない。**残り8件**（code-requests、code-session、events×3、bots/[id]/route、rooms/[id]/code、goal-loop）。
**ターン85**: 2件目を解消。非所有モードの`GET /api/tasks/[id]/events`は**ローカル購読もensureLiveも行わず**、Backendのdetail（`forwardTaskDetail`）でreadyスナップショットを組み、2秒間隔のポーリングで更新を送る（`eventType: "remote_poll"`）。待機中の承認・質問は所有プロセスのメモリにあるため`/internal/pending-snapshots`から取得して`permissionRequest`／`questionRequest`に載せる（読取失敗は「待機なし」として扱いストリームは継続）。Backendが読めない場合は`event: error`で終了しローカルへフォールバックしない。**残り7件**（code-requests、code-session、bots/[id]/events、bots/[id]/route、rooms/[id]/code、rooms/[id]/events、goal-loop）。
**ターン86**: 3件目を解消。非所有モードの`GET /api/bots/[id]/events`もBackendのdetail＋pending snapshotsから組み、2秒ポーリングで配信する（`eventType: "remote_poll"`）。この分岐を共通ヘルパー`web/src/lib/pi/backend-event-stream.ts`（`backendTaskSnapshot`／`startBackendTaskStream`＝ready送信→ポーリング→`stop`でクリーンアップ）へ抽出し、Botのintercom inboxは共有ファイルのローカル読みとして同梱する。**残り6件**（code-requests、code-session、bots/[id]/route、rooms/[id]/code、rooms/[id]/events、goal-loop）。
**ターン87**: 4件目を解消。非所有モードの`GET /api/bots/rooms/[id]/events`は、Roomファイルとlinked Code要求は共有ディスク読みのまま、待機中の承認・質問だけを`forwardPendingRequestsByTask`（`/internal/pending-snapshots`を1回読んでtaskId別にまとめる）から取る（2秒更新ごと・再入防止つき、読取失敗は空マップで次回再試行）。**残り5件**（code-requests、code-session、bots/[id]/route、rooms/[id]/code、goal-loop）。
**ターン88**: 5件目を解消。Backendに `POST /internal/bots/:id/code-requests`（`BACKEND_BOT_CODE_REQUESTS_SUFFIX`、`{action:"abort",requestId}`）を追加し、`entry.mjs`が`stopBotCodeRequest`→（linked Codeがあれば）`abortTaskIncludingColdGoalLoop`→`completeBotCodeRequest`を実行する（outbox書込は所有プロセスのみ）。バンドルentryに`stopBotCodeRequest`／`completeBotCodeRequest`を追加して再ビルド（`REQUIRED_RUNTIME_EXPORTS`にも追加）。Webの非所有モードは`forwardBotCodeRequestAbort`で転送し、404はそのまま404、未設定は409（`RUNTIME_NOT_OWNED`）、その他は502（`BACKEND_FORWARD_FAILED`）でローカル停止へフォールバックしない。**残り4件**（code-session、bots/[id]/route、rooms/[id]/code、goal-loop）。
**ターン89**: 6件目を解消（制御系）。Backendに `POST /internal/tasks/:id/goal-loop`（`BACKEND_TASK_GOAL_LOOP_SUFFIX`、`{action:pause|resume|stop|complete, maxTurns?, botId?}`）を追加し、`entry.mjs`はBot所有のstopで`stopBotCodeTask`→`goalLoopState`、それ以外は`goalLoopCommand`を実行する（ループは所有プロセスの中にある）。バンドルentryに`goalLoopCommand`／`goalLoopState`を追加して再ビルド。Webの非所有モードはPATCH（pause/resume/stop/complete）を`forwardGoalLoopControl`で転送し、404はそのまま404、未設定は409、その他は502でローカル制御へフォールバックしない。POST（start）はAuto/モデル/エージェント解決がWeb側にあるため409（`GOAL_LOOP_START_NOT_SUPPORTED`）で**明示的に拒否**する（中途半端に実行しない）。**残り3件**（code-session、bots/[id]/route、rooms/[id]/code）。
**ターン90**: 7件目を解消。非所有モードの`PATCH/DELETE /api/bots/[id]`は、Botの無効化・会話リセット・削除で止めるセッション（linked Code＝`stopLinkedBotCodeSession`、Bot自身の1:1タスク＝disable時）を、既存の`/internal/tasks/:id/abort`（BotタスクID＋`{botId}`）へ`forwardTaskAbort`で転送する。ローカル停止は行わない（見つからず、本物のセッションが走り続けるため）。**残り2件**（bots/[id]/code-session、bots/rooms/[id]/code）。
**ターン91**: 8件目を解消。非所有モードの`POST /api/bots/rooms/[id]/code`（Roomの委譲Code停止）は、要求の探索（Roomファイル＝共有ディスク）はローカルのまま、停止を`forwardBotCodeRequestAbort`でBackendのoutbox所有者へ転送する。404（要求が変わった）はローカルと同じく409、未設定は409（`RUNTIME_NOT_OWNED`）、その他は502（`BACKEND_FORWARD_FAILED`）でローカル停止へフォールバックしない。**残り1件**（bots/[id]/code-session）。
**ターン92**: 9件目を解消し、**未配線は0件**。非所有モードの`POST/PATCH /api/bots/[id]/code-session`は、起動（`createBotCodeTask`）と操作（clear/unlink/continue/Goal Loop制御）を409（`CODE_SESSION_NOT_SUPPORTED`／`CODE_SESSION_CONTROL_NOT_SUPPORTED`）で**明示的に拒否**する。起動の転送（Bot Codeタスク作成のBackend化）は未実装で、停止系は別route（`bots/[id]/abort`・`bots/[id]/code-requests`）から所有プロセスへ届く。カバレッジテストは「未配線リストが空であること」を検証するようになった＝**どのrouteも非所有モードで第二の所有者として振る舞わない**。

### Phase 6 撤去手順（確定・未実施）

前提: 実切替（`LEAFCODE_PI_CUTOVER=1`でのHost起動）を一度実施し、`/api/backend/status`の`cutover.blockers`が空で運用できることを確認してから行う。**旧経路とBackendの同時所有は常に禁止**。

1. **中継フォールバックの廃止**: `relayTaskRows`／`relayBotList`の「Backend失敗時に`null`を返してプロセス内経路へ戻す」分岐を削除し、失敗をそのままエラーとして返す（`backendRelayCompatible`の5秒キャッシュも不要になる）。
2. **旧経路（Web内SDK所有）の停止**: Hostを`LEAFCODE_PI_BACKEND_OWNS_RUNTIME=1`＋`LEAFCODE_PI_BACKEND_RELAY=1`で常時起動し、`LEAFCODE_PI_BACKEND=1`（Backend常駐）を既定にする。Webの`localRuntimeBlocked()`は常に真になる。
3. **harness依存の除去**: Webの`@/lib/pi/harness` import を、非所有モードで拒否している機能（Bot Codeセッション起動、Goal Loop開始、AUTO解決を伴う起動）の転送を実装したうえで、起動・停止・回答・購読の各経路をBackend APIへ置換し、`backend-runtime-entry.ts`（Backend側のバンドルentry）だけを残す。
4. **未使用の撤去**: `LEAFCODE_PI_BACKEND_RELAY`／`LEAFCODE_PI_BACKEND_OWNS_RUNTIME`スイッチ、`runtime-ownership.ts`の「所有モード」分岐、`backend-relay.ts`の全体を削除する。

**未達（実切替までに必要な残作業・実測）**

- Bot Codeセッション起動の転送（`createBotCodeTask`／`continueBotCodeTask`のBackend化）。現状は非所有モードで409拒否。
- Goal Loop開始（`start`）の転送。Auto/モデル/エージェント解決がWeb側にあり、現状は409拒否。
- SSEは非所有モードで2秒ポーリング（`eventType: "remote_poll"`）。所有モードの即時配信と比べ遅延がある。
- 実切替の未実施（Host・WebUIの再起動を伴うため、ユーザー承認後に実施）。
- Web全体の型検証は既存の拡張（`leafcode-goal-loop`／`loop-guard`）が`@earendil-works/pi-coding-agent`を解決できず失敗するため、本番用`tsconfig.build.json`で代替している。

### 最終棚卸し（ターン93時点・実測）

- `backend/core/`＝**50モジュール／62テストファイル**、`backend/src/`＝`server.mjs`／`entry.mjs`／`runtime-host.mjs`／`startup.mjs`／`runtime-loader.mjs`（各テスト付き）。
- 内部API: `/internal/health`、`/internal/pending-snapshots`、`/internal/tasks`（一覧・`:id`・`:id/detail`・`:id/prompt`・`:id/permission`・`:id/question`・`:id/abort`・`:id/goal-loop`）、`/internal/bots`（一覧・`:id`・`:id/code-requests`）。
- カバレッジ: セッションを触る**16 routeすべてがガード済み**（未配線0件、テストで検証）。
- スイッチ: `LEAFCODE_PI_BACKEND`／`_RUNTIME`／`_RUNTIME_BUNDLE`／`_RELAY`／`_OWNS_RUNTIME`／`_GENERATION`／`_URL`／`_TOKEN`／`_PORT`／`_DATA_DIR`／`LEAFCODE_PI_CUTOVER`。
- 世代: バンドル内容ハッシュ（16桁hex）。Hostがpinし、Backendは不一致ならreadyにならない。実測世代は`bd3d66b604a25790`（ターン89以降のバンドル）。

### 全体検証（ターン94・実測）

- Backend: **721 pass / 0 fail**（`npm run test:backend`）。
- Host: **250 pass / 0 fail / 3 skip**（`npm --prefix host test`、253件）。
- shared: **8 pass / 0 fail**（`node --test shared/*.test.mjs`）。
- web全スイート: **4441 pass / 3 fail**（474ファイル中4ファイルが失敗。いずれも既存: `extensions/leafcode-mcp-adapter/proxy-visibility.test.ts`＝typebox、`extensions/leafcode-subagents/.../subagent-runner.test.ts`＝負荷時のフレーク、`src/app/api/health/route.test.ts`＝dataDir、`src/components/MessageCardRadius.test.tsx`）。
- web本番型検証（`tsconfig.build.json`）: **0エラー**、`eslint src`: 指摘なし。
- 検出した回帰1件: `src/lib/shared-types.test.ts`のミラー検証が新しい契約ファイル（`shared/bot-tools.mjs`／`.d.mts`）を写しておらず失敗（本番のミラーは`shared/`全体を写すため影響なし）。テスト側を修正して解消（`3770a9fc`）。

**切替runbook（実行は未実施）**
1. `npm run build:backend-runtime` でバンドルを更新し、`bundleGeneration`を確定する（世代が変わると稼働中Backendはreadyにならない）。
2. Goal Loop・稼働中タスク・leaseが無いことを確認（`cutoverPreflight`のblockerが空）。
3. `LEAFCODE_PI_BACKEND=1`でHostを起動し、Backendをdetachedで常駐させる（この時点では旧経路＝Web所有のまま）。
4. 切替を実行: WebUI停止→Backendをattachで再起動→`/internal/health`が200（世代一致）→WebUIを`LEAFCODE_PI_BACKEND_OWNS_RUNTIME=1`＋`LEAFCODE_PI_BACKEND_RELAY=1`で再起動。
5. 確認: BackendのPIDが変わらず継続、`/api/backend/status`の`cutover.blockers`が空、storeのmtimeが二重writerで増えていないこと。
6. ロールバック: Backend停止→WebUIを所有側（relay無効）で再起動。旧経路は残してあるため即時復帰できる。
**未完（実切替前に必要）**: promptTask経路のSDK実行本体、relay要求キューの状態遷移本体、ルーティン実行本体（いずれもWebプロセスのharness/routinesに残る）、起動列の`entry.mjs`接続とready化、内部APIとWeb中継、Host・ビルド・再起動分離、実切替、旧経路撤去。

1. 通信契約・依存境界: **進行中**。認証、版数、health、起動/停止を追加。既存のタスク・モデル・質問/承認・Bot/Room・履歴・Git等のDTOを `shared/types.ts` へ移動。既存 `@/lib/types` は互換再エクスポート。共有契約はNext/SDK/Node型への依存なしで単独型検証できる。設定等の個別ファイルにあるDTOと実行依存の抽出は後続。
2. Next非依存の実行層: **着手済み・未完**。下表のとおり、Next/SDK/アプリストアに依存しない判定・順序・保存をBackend coreへ移設し、Webは同名の互換入口（注入アダプター）にした。実測（2026-09-30時点）: `backend/core/` は**48モジュール・60テストファイル**、`backend/src/` は transport と起動アダプタの4ファイル（`server.mjs`・`entry.mjs`・`runtime-host.mjs`・`startup.mjs`）。Backendテストは**695件成功**（重複プロセスのlease競合試験を含む。同試験は高負荷時にワーカー起動自体が失敗することがあり、起動失敗のみ再試行する）。Web側は前回の全件実測で**4339件成功・2件失敗**（既存の`/api/health`のdataDir、`MessageCardRadius`）と、MCP拡張の`typebox`未解決によるファイル単位の失敗1件で、いずれも本作業とは無関係。高負荷時にsubagents拡張の並行実行テストが失敗することがあるが、単独実行では成功する（負荷起因のフレーク）。移設済みモジュールはNext/Webをimportせずに読み込め（多くは別Nodeプロセスでの実行もテスト済み）、Backend側テストで挙動を固定している。ただし **Backendプロセスは実行経路に未接続** で、SDK・ストア・leaseの実体は従来どおりWebプロセス内にある（HTTP Backendのhealthは503/startingのまま。内部読み出しAPIは`/internal/pending-snapshots`（認証・プロトコルヘッダ必須、GETのみ、store未注入なら空配列）まで追加済み。Web側は `web/src/lib/pi/pending-snapshots.ts` のプロセス内singletonへ `scheduleTaskSnapshot` が記録し、live破棄時にclearする経路まで入ったが、Backend側は `entry.mjs` がcoreのstoreを生成して `readPendingSnapshots` に注入するところまで接続済み（起動プロセス単体で空配列を返し、healthは503のままであることをCLIテストで固定）。ただしWebプロセスのstoreとBackendプロセスのstoreは別物で、実際の供給（harness→Backend）は未接続）。

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
   | `restart-resume.mjs`（追記） | 再開可否の拒否順序を `restartResumeRefusal` として固定（変更/停止/削除済み→Room委譲→Goal Loop所有、所有判定は厳密true）。再開経路と、ランタイム未接続プロセスの分類が同じ判定を使う | 試行予算の記録・遅延実行・promptTask |
   | `pending-prompts.mjs` / `webui-bridge.mjs` | 質問/承認の待機キューとタイムアウト、ブリッジ受付口（globalThisの枠・未登録時null） | harnessのprocess-localシングルトン、拡張側コピー |
   | `webui-bridge.mjs`（追記） | プロセス内で1つのpromptサービスを共有する規則を `ensureGlobalPromptService` として固定（globalThisキーで再利用、`create`は未作成時のみ、ブリッジハンドラは毎回現インスタンスへ再登録。Nextのroute bundle・hot reloadを跨ぐ） | サービスの依存（resolveTaskId/emit/snapshotExtras）とglobalThisキー名 |
   | `prompt-control.mjs` | steer/followUp分岐、ストリーム待機、prompt世代、キュー破棄、思考必須エラー判定 | `live`セッション本体・prompt連鎖 |
   | `prompt-control.mjs`（追記） | prompt選択の適用規則（`resolvePromptPermissionOptions`=ピン留め優先・Settingsはlive有りのみ補完、`shouldApplyPromptModelSelection`/`shouldApplyPromptThinkingLevel`=差分があるときだけ書戻し、`isRecoverableResumeSelectionError`=再開時のモデル/アカウント削除のみ許容） | ストア書戻し・Settings読取 |
   | `prompt-control.mjs`（追記） | 送信リトライと結果受渡の判定を `reasoningFallbackLevel`（思考オフ不可モデルはoff以外の最小レベル、無ければminimal）／`shouldRetryWithReasoningFallback`（reasoning必須400のみ1回だけ再試行）／`shouldCompleteCodeRequestAfterPrompt`（Code結果はoutboxへ渡すがwatchdogがresolving中は渡さない）として固定 | SDK送信・thinkingLevel書込・relay完了呼び出し |
   | `prompt-control.mjs`（追記） | 送信直前の判定を `shouldApplyPromptSubagentPermission`（ピン留めは常に適用、CodeタスクはSettings追従、Botタスクはピン留め時のみ）／`shouldDemoteInterrupt`（steer先のストリームが無い割り込みは次ターンへ降格）／`shouldWaitForSteerStreamBeforeSend`（ストリーム未開始のsteerのみ待機）として固定 | SDKセッションへの適用・待機・降格の実行 |
   | `prompt-control.mjs`（追記） | アカウント再ルーティングの可否を `canRouteAccountForPrompt`（reroute要求・provider/model有り・非ストリーミング・ユーザー発話かGoal Loopターン・integratedルーティング・明示accountなし）と `stillEligibleForAccountRouting`（ロック内での再判定。待機中に付いたpinやストリーミングで中止）として固定 | provider/account判定関数・ルートロック・実際の再選択 |
   | `prompt-control.mjs`（追記） | 送信種別の決定を `resolvePromptSendKind`／`promptSendCustomType`（Code結果→provider fallback→transport recoveryの優先順、該当なしは通常prompt、内部種別は非表示のcustom message）と `shouldIgnorePromptError`（手動abort後のエラーは失敗扱いにしない）として固定 | custom type名の定義・SDK送信・状態遷移 |
   | `prompt-control.mjs`（追記） | hang-watchの扱いを `resolveHangWatchQueueAction`（Code結果は解除、steer/follow-upと`skipRearm`は維持、他は武装）と `shouldArmHangWatchAtSend`（`skipRearm`は送信時に武装）として固定 | 実際のタイマー武装/解除と`stillQueued`判定 |
   | `prompt-control.mjs`（追記） | prompt送信前のゲート順序（アーカイブ済みプロジェクト→Botコード転送→他ワーカーlease。各判定はthunkで、拒否された場合は後段のlease読取を行わない）と、Botコード転送の可否（Botタスク/記録なし/無効/自プロセスleaseは転送しない） | プロジェクト取得・Bot記録・lease読取 |
   | `abort-control.mjs` / `abort-coordinator.mjs` | ユーザー停止とhang watchdog停止の副作用順序（副作用は注入） | Goal Loop・サブエージェント停止の実体、スナップショット配信 |
   | `live-lifecycle.mjs` / `live-replace.mjs` | dispose時のRoom busy・shutdown要否判定、置換時の旧live切離し順序（購読解除→旧アカウント参照の解放→旧セッション破棄→スナップショットタイマー取消）、attach時のアカウント決定と1:1 Bot liveのmailbox昇格判定（Roomは昇格しない）、extension shutdown→session disposeの順序とin-flight登録、ensure-live世代の照合と「登録済みliveが自分のattach結果か」の判定・in-flight ensureの登録/解除（新しい試行が置き換えたら古い側は消さない）・未接続セッションの破棄（session_shutdownは出さず例外は握りつぶす契約）・セッション生成直後/attach直後の扱い（世代が古ければ破棄して再試行、タスク消滅は404、attach結果が最新でなければ破棄しない）・in-flight ensureに合流した後の扱い（世代が古ければ採用せず再試行）、置換の共通末尾（永続化先行・失敗時の破棄と復元） | `live`のmap・購読・`attachSession`/`ensureLive`/`createSession` |
   | `live-lifecycle.mjs`（追記） | attach後の公開順序（stopフック代入→activity刻印→liveマップ登録→1:1メールボックス昇格）を `publishAttachedLive` として固定。途中失敗は伝播し、後続は実行しない | 各ステップの実体（`stopLive`・`current.live`・`promoteMailboxOnAttach`） |
   | `live-lifecycle.mjs`（追記） | 保留設定のキー契約と消込規則を `PENDING_LIVE_SETTING_KEYS`（8キー・比較/適用順）と `remainingPendingLiveSettings`（適用済みと同値のキーだけ削除、適用中に変わった値は残す、空ならundefined）として固定 | ストア書込・SDK適用・pendingSettingsの保持 |
   | `live-lifecycle.mjs`（追記） | 保留設定の適用を `isSamePromptRoute`（account/provider/modelが一致すればセッション置換せずin-placeでモデル変更）と `SOFT_LIVE_SETTING_KEYS`／`softLiveSettings`（busy中はpermissionMode→subagentPermission→botToolsのみ即時適用、他は保留継続。該当なしは`undefined`で「適用対象なし」を区別）として固定 | SDK適用関数・セッション置換・ストア書込 |
   | `live-lifecycle.mjs`（追記） | 遅延リロードの判定を `shouldApplyPendingReload`（streaming/compacting中は保留、`promptActive`はbusy扱いしない）／`shouldFlagSoulReload`（BotタスクかつSOUL revision差分があるとき）／`shouldReloadAgentDefinition`（保留フラグまたは未登録）として固定 | revision読取・SDK再読込・in-flight管理 |
   | `live-lifecycle.mjs`（追記） | 設定適用の遅延判定を `shouldDeferLiveSetting` として固定（実行中/ストリーミング/コンパクション中、`working`、Goal Loopセッション、Goal Loop所有のいずれかで遅延。フラグは厳密true） | Goal Loop状態の読取と`isLiveBusyForReplace`相当の判定 |
   | `live-lifecycle.mjs`（追記） | ensure-liveの再利用/合流判定を `resolveEnsureLiveAttempt` として固定（登録済みlive→activity更新して再利用、in-flightがあれば合流→タスク再確認→世代が現行なら採用、そうでなければ新規試行）。in-flightの失敗は合流側へそのまま伝播 | レジストリ・epochマップ・`throwIfTaskArchived`・再帰呼び出し |
   | `live-lifecycle.mjs`（追記） | ensure-liveの開始ゲート順序を `runEnsureLiveGates` として固定（attach可能判定→promotion待ち→再判定→retirement待ち）。前段の失敗は握り潰し、後続を止めない | 各ゲートの実体（`getTask`・`promoteInflight`・`liveShutdownInflight`） |
   | `live-attach-state.mjs` | attach時のlive初期状態（置換前liveのマップ/プロンプト連鎖/世代の引継ぎ、task由来の復元値、transcript由来のタイミング復元。versioned mapは注入） | transcript走査とversioned mapクラス、SOULリビジョン取得 |
   | `live-session-preflight.mjs` | liveセッション生成前の拒否理由の優先順位（task不在→archive済→他workerのlease）と、セッション設定の決定（Bot判定、workspace、sessionNameのBot名前空間、権限モードとskill permissionのフォールバック、セッションが使うアカウントの選択と明示アカウントの拒否理由、保存済みモデルの解決結果（解決済み/Autoで代替/利用不可=503）、思考レベルの出所（保存値/モデル既定/無し）） | エラー文言とHTTPステータス、通知などの副作用 |
   | `live-session-preflight.mjs`（追記） | refusalの共通知文とHTTP対応を集約（`TASK_NOT_FOUND_MESSAGE`=404、`TASK_ARCHIVED_MESSAGE`=409、`liveSessionRefusalError`はlease文言を注入）。harnessの重複した例外生成2箇所を置換 | 呼び出し側の`throw Object.assign(new Error(...), {status})` |
   | `live-session-preflight.mjs`（追記） | 新規セッションの権限既定値を `resolveSessionPermissionDefaults` として固定（CodeはSettings追従、Botは未指定skill=allow・未指定subagentは継承しない、ピン留め値が優先） | Settings読取（skill/subagent権限） |
   | `live-session-preflight.mjs`（追記） | 再開するCodeセッションがタスクへ書き戻す権限差分の比較規則を `resolveCodePermissionUpdates` として固定（Botは対象外、Settings追従タスクのみapprovalMode、未保存のskill権限は既定値扱い、変更なしは省略） | Settings読取（`readCodePermissionMode`等）とタスク更新 |
   | `session-event-decisions.mjs` | セッションイベントごとの判定（agent_start/settled/endでの同期要否、自動コンパクション失敗の判定と記録メッセージ、transport復旧中のsettle抑止、task行が消えたイベントの破棄、agent_startのlease取得→working公開の順序） | イベント受信時の副作用の実体（タスク更新・状態遷移・スナップショット） |
   | `session-event-effects.mjs` | 1イベント分の副作用順序（tracker3種→自動コンパクション判定→同期要否→タスク読取→打ち切り判定→throughput→agent_startのlease取得→settle→コンパクション失敗の記録→識別投影→スナップショット）と2つの早期終了 | 各ステップの実体（harnessのtracker・ストア・settle・emit） |
   | `goal-loop-settings.mjs` | Goal Loopのターン上限・クールダウン（数値/`1h 30m`形式の解析・整形）・受け入れ条件の正規化と上限・所有ステータス判定（live＋operator hold） | `lib/goal-loop-settings.ts` は同名exportの互換入口 |
   | `goal-loop-settings.mjs`（追記） | Goal Loopコマンドの制御判定を `isGoalLoopControlAction`（pause/stop/completeは世代失効後もセッションへ届ける）と `shouldRollbackStaleGoalPrepare`（start/resumeが準備したworking＋leaseは、自プロセスがleaseを保持し何も実行していないときだけ巻き戻す）として固定 | 状態遷移・lease解放・snapshot emit |
   | `goal-loop-state.mjs` | Goal Loop状態ファイルの読取（dataDir配下`goals-loop/<安全化したsessionId>.json`、mtime/size/inodeで検証する上限付きキャッシュ、欠落・破損・不正形はnull、数値/配列フィールドの正規化）とoperator hold判定 | データディレクトリ・設定値のclamp・呼出側の書き込み |
   | `snapshot-schedule.mjs` | スナップショットの合流規則（非描画イベントの除外、高頻度イベントのdelta化、フル待機中のdelta破棄、100ms窓、発火時に読むpending内容）と、unsubscribe時の後始末順序（タイマー取消→pending消去→保留分のemit） | タイマー実体とSSE emit |
   | `task-detail.mjs` | タスク詳細の読み出し元の決定（`resolveTaskDetailSource`=archived→保存transcript、offlineまたは他ワーカーlease→transcript、それ以外は自プロセスのlive）と `detailStreamingFlag`（archivedは常にfalse、offlineは`working`のみtrue、liveはセッション判断でnull）／`detailIncludesGoalLoop`（archivedのみ除外）、`TASK_DETAIL_TIMEOUT_MS`=30s／`TASK_DETAIL_OFFLINE_TIMEOUT_MS`=10s、`isDetailTimeoutError`（timeoutフラグで判定）、`detailTimeoutError`（live/offline/finalの文言とstatus。finalは503）、`offlineDetailFlags`／`liveDetailFlags`（transcriptは常に非compaction・欠落retryは0、liveはセッション値優先で0は保存値を隠さない）、`liveDetailErrorStatus`（status付き拒否はそのまま、他は503）、`detailIncludesMessages`（明示falseのみ省略）、`shouldSuggestCompaction`（Goal Loop所有セッションでは提案しない）） | 詳細payloadの組み立て・transcript読取・セッション参照・タイマー |
   | `attention.mjs` | 待機中permission/questionの所有キー決定（`resolveAttentionSource`=非Botは自分のキー、Botは自分の要求→委譲セッションの所有要求→Botキーの順。複数委譲時は所有する要求を選ぶ）とattention項目の形（`attentionItemForTask`=kindsはpermission→question順、originは既知のときのみ、待機なしはnull）、`attentionClearTargets`=タスク自身を先頭に、委譲Codeは明示指定かつBotタスクのときだけ重複なく追加、`attentionEmitPlan`=タスク本体に加えて重複しないoriginへも通知（originは自身の状態のsnapshot）） | プロンプトサービスのレジストリ・relay参照・タスク取得 |
   | `pending-snapshot-store.mjs` | タスク別の保留スナップショット保持（`record`/`read`/`clear`/`list`、再記録は最新扱い、上限超過は最も古いタスクから退避、読み出しは複製、上限0以下は無効） | タイマーとemit（`snapshot-schedule.mjs`の判定を呼ぶ側） |
   | `session-identity.mjs` | セッションが報告する識別情報（sessionId/sessionFile/provider/model）の選択（タスクモデル保持時はtranscript位置のみ）と保存済みタスクとの差分計算、書き込む変化があるかの判定。欠落値で保存済みを消さない規則を含む | `lib/pi/session-identity.ts` は同名exportの互換入口 |
   | `routine-scheduler.mjs` | scheduler lock（stale時のみ再取得）、実行対象判定（cronはcore実装を既定とし注入も可。解析不能なscheduleはtickを壊さず対象外）、切り離し起動 | ルーティン保存と実行本体 |
   | `routine-scheduler.mjs`（追記） | 失敗時の記録と自動無効化（`nextRoutineFailureState`=失敗数を加算し無効化済みは再有効化しない、`routineAutoDisabled`=上限到達で注記、`isTransientRoutineStartError`=ワーカー競合は失敗に数えない） | ルーティン記録の更新・実行本体・通知 |
   | `routine-schedule.mjs` | cronの解析・照合（`*`/範囲/リスト/ステップ、日曜=0と7）、次回実行時刻の探索、ピッカーの下書き変換と説明文 | `lib/routine-schedule.ts` は同名exportの互換入口 |
   | `skill-filters.mjs` | skillの除外規則（scope別stateで無効化された名前だけ除外し空stateは複製を返す、Botのinherit/include/exclude適用、未知modeは素通し、保持要素の同一性維持） | skills-stateの読取（`readSkillsState`既定引数）とSDK由来skillオブジェクト |
   | `directory-lock.mjs` | 複数workerで共有するロックディレクトリの同期ロック（stale回収・待機上限・busy通知。rooms/routinesが共用） | hang-watchdog・web-settings・pi-auth・model-throughput-stats・transfer-recoveryの個別ロック実装（待機間隔や非同期性が異なり未統合） |
   | `keyed-serializer.mjs` | キー（promotion先ディレクトリ等）ごとの直列化（前の保持者を待つ→実行→解放、置換された古い保持者はエントリを消さない、異なるキーは並行） | 対象キーの正規化と実行内容 |
   | `room-recovery.mjs` | 放置working発言の判定、handoff整理と再配信 | Room保存・実行 |
   | `room-normalize.mjs` | 保存済みRoom JSONの検証・正規化（不正なメッセージ/handoff/outcomeの破棄、メンバー重複除去、opt-inフラグ。handoff状態の語彙は共有DTO定数を注入） | Room読書き・書込み・イベント発火・Bot検証 |
   | `room-store.mjs` | Roomファイルの読書き（原子的tmp+rename、ID検証、更新日時降順の一覧、書込後の通知フック）、データディレクトリの解決、live上限を超えた発言のhistory.jsonlへの追記、画像・添付のパス検証と読出、relay状態（relay.json）の読書き、relay envelopeの発行・消費（深さ上限・TTL・consumed・claimsによる重複参加の拒否） | ルート解決（dataDir配下）とprocess-localなイベントバスの実体 |
   | `room-relay.mjs` | relay envelopeの発行・消費（深さ上限3、TTL10分、consumed、親envelopeの検証、claimsと既参加ターンによるfan-out拒否、room lock下の原子的クレーム） | 部屋とBotの実体・ロック・時計・UUID |
   | `bot-code-report.mjs` | Bot向けCode結果報告プロンプトの組立 | Room用前置きプロンプトの生成 |
   | `bot-code-request.mjs` | Botコード要求の同一性と生存判定（Room由来task idの`bot:<botId>:room:<roomId>`解析、要求idは64桁小文字hex、Room要求の生存規則: 応答が現行ターン・会話が最新の作業要求を指す・Botが現行メンバー、`/stop`後のエラー終了のみ配信継続可） ｜ 要求の選択規則（`isActiveCodeRequest`=delivered/cancelledのみ非active、`selectActiveCodeRequestForTask`=最新のactive非intervention要求をqueuedAt降順+id降順で一意に選ぶ、`runningCodeTaskIdsForOrigin`=starting/runningのみを読取順で返す、`resolveOutboxScanAction`=queuedは開始・startingはbusy中は待機でbusyでなければ再キュー、`cancellationTargetForRequest`=queuedは中断対象なし、`codeRequestPayload`=配信済み結果のoutcome/goalLoopのみ公開（不正JSONはlegacy文字列としてoutcome化）、`userStoppedResult`=生成済みフィールドを保持しoutcomeだけ停止マーカーへ、`codeSessionChangedPayload`=状態変更イベントのpayload（harnessの`emitCodeSessionChanged`が使用）、`codeCompletionAction`=runningは結果取り込み・starting+停止は停止結果を記録してreadyへ・ready+停止は結果のみ書換・他は何もしない、`codeResultBaselineMessages`=baseline以降のみ（baseline消失時は空）、`codeResultLatestAssistant`、`codeResultOutcome`=削除→停止→中断→失敗→Goal Loop判定→実行終了→取得不能の優先順、`codeResultOutput`=上限で切詰めとtruncated、`CODE_DELIVERY_RETRY_MS`=30秒、`shouldAttemptCodeDelivery`=origin実行中またはバックオフ未失効なら待機（失効判定は`>`）、`shouldConfirmCodeDelivery`=delivered/cancelledは上書きしない、`CODE_REQUEST_RETENTION_MS`=7日、`CODE_RELAY_TICK_MS`=2秒、`shouldPruneCodeRequest`=非activeかつ保持期間超過のみ削除（stat失敗時は削除しない）、`shouldStartCodeRelayTick`=実行中は次を開始しない、`activeCodeRequestIds`=スキャン対象は活性のみで読取順、`CODE_SESSION_EVENT_TARGETS`=状態変更はorigin taskとrelayチャンネルの両方へ同一payload、`truncateCodeReportRequest`=コードポイント単位で上限に切詰め（省略記号も上限に含む）、`parseGoalLoopInput`=goalLoop入力の検証・正規化・クランプ（非object・型違い・不正acceptanceは専用メッセージで拒否）、`codeTaskIdRefusal`／`codeGoalLoopRefusal`／`codeReportingRefusal`／`codeAutoChainRefusal`／`codePromptRefusal`（Botツール入力の拒否順と文言。加えて開始前検証: `codeLinkedSessionState`=missing→archived→denied→busy→available、`codeLaunchRefusal`=Bot権限→Room現行性→未知action→リンク先状態、`codeProjectRefusal`=要求されたprojectのみ判定。`buildCodeRequestRecord`=開始レコードの組み立て（promptはリンク先IDとbaseline、startは両方null、空のgoalLoop/autoChain/room/imagesはキーごと省略）、`codeRequestSummary`／`codeRequestSummaries`=Botパネル一覧の射影（公開6フィールド＋outcome/goalLoop、intervention除外、queuedAt降順で欠落は最後）、`botCodeReportText`=レポート検出（要求IDのcustom messageで窓を開き、次のCode結果かユーザー発話で閉じる。窓内の正常終了assistantで本文が空でないもののみ）、`codeRequestsForRoomTurn`=Roomターン単位の要求選択（roomとconversation.requestIdで一致、exclude指定可、activeOnlyで活性のみ）、`codeStopTargets`=停止対象のCodeセッション一覧（決着済み要求も含める。cold-gap orphanを残さない）、`shouldStopCodeSession`=存在・非アーカイブかつworkingかGoal Loop所有のときのみ停止、`codeRequestForCodeTask`=Codeタスク→要求の逆引き（starting/runningのみ・intervention除外・読取順で最初）、`reportingStateForRequest`=レポート中フラグの初期値（roomはtruthy判定・userStoppedは厳密true・followUpスロットは開）、`markFollowUpAttempt`=成功時のみスロットを消費し拒否時は開いたまま、`shouldDispatchUserIntervention`=Codeセッション無しは何もしない、`shouldCancelCodeDispatch`=タスク消失/アーカイブは取消、`codeDispatchResultState`=成功でdelivered・失敗でqueuedへ戻す、`adoptSupervisionRefusal`／`releaseSupervisionRefusal`=監督の付与・解除条件（ユーザー開始のCodeタスクのみ・別Bot監督中は拒否・実行中のみ・解除は監督リンクがあるときのみ。同一Botの継続監督は許可））。taskIdは既存セッションのみ・goalLoopはstart時のみ・停止済み/Room報告中は制御不可・追従1回まで・promptは1〜32000字）） | Roomストア読取・要求ファイル・`/stop`文言（`isRoomStopRequest`） |
   | `bot-session-options.mjs` | BotセッションのSDKオプション組み立て（Bot以外はnull、system promptはsource順でRoom由来のみRoom文を末尾追加、context files無効、tools未設定は既定一覧、`powershell`はwin32以外で除外、skillScope=bot） | ボット記録・prompt source・Room判定・プラットフォーム |
   | `replaced-packages.mjs` | 置換対象パッケージ判定（npmのbare文字列/`{source}`両形式、バージョン固定の有無、computer-useは既知のowner/repo形式のみ一致）と、fork/upstream表＋重複排除規則（`replacedUpstreamPackages`は`skipDiscovery`のみ除外、`keepsLoadedExtension`は置換済みupstreamと古いバンドル重複を除外しバンドル自身は残す） | settingsProxyと拡張ロード |
   | `bot-intercom-policy.mjs` | inbound triggerポリシー別のidle起動可否（never/always/replies、未知ポリシーはreplies扱い、askは常に応答が必要）とpresence判定（live無し=offline、応答待ち/実行中/Room中=busy、他はonline） | `lib/bot-intercom.ts` は同名処理を委譲、設定読取・mailbox・thread・lookupは Web 側 |
   | `prompt-markers.mjs` | プロンプト本文の内部マーカー（Bot送信・ハング再送）の語彙と付与/除去（付与は冪等、先頭のみ認識、入れ子判定、表示用の全除去） | `lib/hang-retry.ts`・`lib/pi/messages.ts` は再exportし、メッセージ解釈はWeb側 |

   修正済み: `createBotConfig` は `skills` の `include`/`exclude` を独立コピーする（移設時に発見した浅いコピーは、1つのBotのskills変更が `DEFAULT_SKILLS` と以後のBotへ波及し得たため、テストで固定したうえでコピーに修正）。**未完（実切替前に必要）**: `live`セッションの所有と`attachSession`/`ensureLive`（開始ゲート・再利用/合流・公開順序・拒否・設定決定はcoreへ移設済みで、残るのはSDK生成・ストア書込・emit実体の呼び出し側）、スナップショット配信、Goal Loop・サブエージェント停止の実体、Bot intercom、各起動サービスの実装、他の業務ストア、待機要求の内部API化（Web再接続時にBackendのpending snapshotを取得して再表示する経路。getTaskDetail・SSE snapshot・attention一覧はすでに同じメモリ上のpendingを返すので、Backend内に限れば再表示は成立している）。同一IDの待機中再送の合流と別セッションとのID衝突の拒否はpending-promptsで実装済み。待機要求のディスク永続化は行わない方針とする（根拠: 待機は SDK のツール呼び出しがプロセス内で await しているため、Backend再起動後に保存済みの要求を復元しても応答先がない。再起動時は孤立タスク照合でerrorになりrestart-resumeが扱う。この前提はセッションをBackendプロセス内に置く限り成り立つ）。WebUI切断中もBackend側の5分タイムアウトは進み、期限後は拒否扱いとなる（従来のブラウザを閉じた場合と同じ）、ブリッジのプロセス間化（現状はプロセス内globalThis）、期限切れleaseの再取得は、複数プロセス競合で旧実装が二重所有（5並列中4つが取得成功）を起こすことを実測した。per-task reclaim lock（再検証付き・10秒でstale回収）で直列化し、同条件で1所有者になることを複数Nodeプロセス試験で確認した。ただしreclaim lock未対応の旧ビルドが同じ`task-leases`を触る間は旧競合が残り、実切替時は旧経路を停止してから切り替える。reclaim lockを残したcrashed holderは10秒で回収する。lock取得に負けた側が一時的に「実行中」と返す挙動は許容仕様。Backend起動アダプタの前提: `backend/src/runtime-host.mjs` に、共通startupの完了後だけreadyになり、失敗・停止時はreadyにならない状態機械（失敗は再試行可、停止は永続、例外本文は出さない）を追加した。`entry.mjs` にはまだ接続せず、healthは503/startingのまま。接続には、startupの各サービスがWeb専用モジュールに依存している点の解消が先に必要: パス解決（`lib/paths.ts` のdataDir・storePath・workspace割当・path同一性）、Bot/Roomストア、`harness`（promptTask・startBotCodeRelay）、ルーティン実行本体。現状でWeb非依存に組み立てられるのはleaseとアプリストアで、そのパス解決（`app-paths.mjs`・`xdg-user-dirs.mjs`）はcoreへ移設済み。Bot/Roomストア、`harness`依存部、ルーティン実行本体のWeb非依存化が残る。全体のWeb型検証は、拡張（`leafcode-goal-loop`/`loop-guard`）が `@earendil-works/pi-coding-agent` を解決できず既存から失敗しており、本番用 `tsconfig.build.json` の型検証で代替している。
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

本ループ（ターン21〜70）で追加した移設: 期限内leaseの二重所有修正（reclaim lock）、待機要求の冪等受付と永続化しない方針、Backendのreadiness状態機械、アプリのパス解決、同期ディレクトリロック、キー単位直列化、Roomの正規化・ファイル読書き・履歴追記・画像/添付・relay状態とenvelope・復旧判定、Botのアイコン語彙・設定正規化・ファイル層・既定値/パッチ・副作用順序・runtime context・プロンプトソース・コードレポート組み立て・intercomの起動ポリシーとpresence判定・セッションオプション組み立て、liveのattach初期状態・公開順序・切離し順序・mailbox昇格・遅延shutdown・in-flight管理・世代照合・生成/attach直後の扱い・未接続セッション破棄・開始ゲート順序・再利用/合流判定、セッションイベント判定と副作用順序・スナップショット合流と購読解除時の後始末、セッション識別と識別差分、liveセッション生成前の拒否順序・共通知文とHTTP対応・権限既定値・再開時の権限差分、Goal Loopの設定と状態ストア、ルーティンのcron解析とスケジューラ既定、置換パッケージ判定と拡張の重複排除、skillの除外規則。いずれもWeb側の互換入口を残し、Backendテストで挙動を固定した。ただし **分離完了は主張しない**。Backendプロセスは依然として実行経路に未接続（healthは503/starting）で、稼働中WebUIやGoal Loopの再起動も行っていない。実切替は「段階3以降（独立API・Web中継、Host分離、旧経路撤去）」を終えた後に行う。
