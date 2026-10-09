# Phase3: JSON業務APIの移管

## 進捗・範囲

Phase3全体は未完了。Phase0のBackend/Phase3/JSON分類は118経路・182操作。Git・Diff・コミット文生成13経路・14操作、定義管理14経路・25操作、Provider/モデル設定7経路・8操作、Provider認証JSON4経路・5操作、アカウント管理/資格情報9経路・19操作、利用量/クレジット3経路・5操作、Peer認証共有5経路・9操作、Workspaceファイル/次タスク提案3経路・3操作、Project lifecycle1経路・4操作、Task collection1経路・3操作、個別Task lifecycle2経路・4操作、Task履歴/検索/bookmark3経路・5操作、Task実行設定4経路・4操作、Task送信/対話応答3経路・3操作、Goal制御2経路・4操作、Task会話編集/昇格4経路・4操作、Task compaction2経路・2操作、Task進行補助4経路・5操作、Task監督/子実行2経路・2操作、Bot lifecycle2経路・5操作、Bot会話3経路・3操作、Bot Code2経路・5操作、Bot routine3経路・6操作、Bot sidebar/内線受信箱2経路・3操作、Room lifecycle2経路・5操作、Room会話コマンド3経路・3操作、TypeSafe設定2経路・6操作、MCP定義/認証3経路・6操作、メモリ検索/システム監視/既読状態3経路・4操作、browse一覧/アイコン2経路・3操作、TTS音声一覧/HTTP合成2経路・2操作の合計115経路・179操作の境界を移管した。認証に付随するログインSSE 1経路・1操作も同じownerへ移管した（Phase3 JSONの集計には加算しない）。残る3経路・3操作には既存Backend中継も含まれ、受入条件の確認・残存業務処理の移管が必要。

以下は第1区切り（Git・Diff・コミット文生成）の記録。第2区切りの定義管理、第3区切りのProvider/モデル設定、第4区切りのProvider認証、第5区切りのアカウント管理/資格情報、第6区切りの利用量/クレジット、第7区切りのPeer認証共有、第8区切りのWorkspaceファイル/次タスク提案、第9区切りのProject lifecycle、第10区切りのTask collection、第11区切りの個別Task lifecycle、第12区切りのTask履歴/検索/bookmark、第13区切りのTask実行設定、第14区切りのTask送信/対話応答、第15区切りのGoal制御、第16区切りのTask会話編集/昇格、第17区切りのTask compaction、第18区切りのTask進行補助、第19区切りのTask監督/子実行、第20区切りのBot lifecycle、第21区切りのBot会話、第22区切りのBot Code、第23区切りのBot routine、第24区切りのBot sidebar/内線受信箱、第25区切りのRoom lifecycle、第26区切りのRoom会話コマンド、第27区切りのTypeSafe設定、第28区切りのMCP定義/認証、第29区切りのメモリ検索/システム監視/既読状態、第30区切りのbrowse一覧/アイコン・Host native選択、第31区切りのTTS音声一覧/HTTP合成は末尾に記載する。

| 経路 | 操作 |
| --- | --- |
| git/branches・log・repositories・show | GET |
| git/commit・commit-message・init・merge・pull・push・rm | POST |
| git/pr | GET・POST |
| diff/files | GET |

## 実行境界

- Nextの対象ハンドラーは `relayJsonBusiness(req, route)` のみ。入力の業務解釈、パス認可、Git/gh実行、ファイル更新、モデル選択・推論・生成キャッシュはBackendの `backend/runtime-src/json-business/handlers/` が所有する。
- 依存閉包のGit・diff parser・commit suggestion・ETag helperの4実装をBackendへ移動し、Webの互換exportを維持した。Backendのビルド入力はWebのソース・パッケージに依存しない。
- `shared/json-business-contract.mjs` は経路/メソッド、上限、公開応答の純粋な契約。FS・SDK・秘密情報・singletonを持たない。
- Nextは認証、Origin/CSRF、世代確認、本文の実バイト数上限のみ実施する。内部Bearer/protocolで `/internal/json-business/<route>` を呼び、ブラウザーのBearer/Cookieは渡さない。Backendは起動/maintenance拒否と認可済みcontextを検証し、変更要求のOriginを再検証する。
- 本文は1 MiB、応答は32 MiBの上限。Gitの既存30秒/4 Mi文字/同時8 capture、ghの既存60秒/16 Mi文字、commit-messageの文字数制限を維持する。
- ディレクトリ・実パス・pathspec・branch/hash・Git引数の検証はBackend。PR確認GETも許可されないディレクトリではgh起動前に拒否する。

## 応答・切断

- 内部応答envelopeで公開status/DTO/ETag/Cache-Controlを運ぶ。Nextで304の空本文、Gitエラー、merge成功後の復帰失敗など既存の部分成功フィールドを再構成する。ownerの任意ヘッダー/公開外のトップレベルフィールドやモデル資格情報は転送しない。
- Backend不在・世代不一致・入口拒否では変更処理を `execution:not-started` とする。送信後の応答喪失・不正な応答は `execution:unknown`。ローカル実行へのフォールバックも自動再送もない。
- 設定のPhase2 ledgerとは異なり、Git操作の永続受付IDや結果照会は実装していない。結果不明の変更は実際のindex/履歴/remote状態を確認してから利用者が判断する。
- 読取の切断はBackendに伝播し、Git capture・gh確認・直接推論を中止する。受付済みの変更はクライアント切断だけではkillしない。Git/PR変更途中の安全なrollbackや原子性を追加したものではない。
- 直接推論失敗時の決定的suggestion fallbackはBackendで維持。provider例外本文を警告/ログに公開しない。

## 検証

- ASTで13経路・14操作が単一の中継returnだけであることを検証。共通契約の純粋性と公開DTO投影も検証。
- Next中継の無書込・本文未解釈・認証/CSRF/実バイト上限・秘密非転送・304/Cache-Control・部分成功・応答喪失/不正応答・切断を検証。
- Backend transportの内部認証/protocol、readiness、メソッド、trusted context、本文上限、例外秘匿、切断の読取/変更区別を検証。
- Webなしの隔離fixtureでBackendをビルド・実起動し、Git init/選択commit/log/branches/show/diff/決定的commit-message、304、危険branch/禁止directory拒否を実行。実プロセス再起動後の同じcommit hashを確認した。
- Git/diff/関連helper/Next中継の対象回帰97件成功。Backend transport・AST境界18件成功。独立プロセスfixture成功。Backend/Web型チェックとBackend強制ビルド（6,761 KiB）成功。API ownershipは165経路・258操作のまま。

### 全体回帰

- 初回Web/lib/API全体: 4,996件中4,962成功・32失敗・2 skip。既知30件はPhase2と同名。追加2件は変更外のAnthropic refresh lockで、該当ファイルの単独再実行は8/8成功。
- Backend/Core/関連build・mirror・境界: 1,409件中1,403成功・失敗2・timeout cancel 4。lease・diagnostics・MCP設定/認証・CLI起動の該当6件はconcurrency=1で6/6成功（34秒）。
- 最終Web/lib/API（Backendと同時実行せずworkers=4）: 4,996件中4,964成功・既知30失敗・2 skip。Phase2の失敗名と完全一致し、新規失敗なし。全体スイートが全件成功したとは扱わない。

稼働中のユーザー設定・Gitリポジトリ・サービスは検証用に変更/再起動していない。OS/remoteへの破壊的Git操作は行わず、実Git検証は隔離fixture内で実施した。

## 第2区切り: 定義管理（14経路・25操作）

- `agents` GET/POST、`agents/[name]` GET/PATCH/DELETE、`skills` GET/POST、`skills/[name]` PATCH、`extensions` GET、`extensions/[name]` PATCH。
- `agents-md`・`bots-md`・`soul-md`・`user-md`・`tools-md`・`design-md`・`workflow-md` GET/PATCH、`prompts/transfer` POST。
- 対象Nextハンドラーは中継returnだけ。動的パラメーターのURLエンコードは入口で、名前はBackend入口だけで1回URIデコードし、権限・ファイル操作・SDK反映はBackendで実施する。二重エスケープされた名前を再解釈しない回帰も追加した。Prompt転送のloopback/WebUIアクセスゲート、厳密なOrigin、20 MiB+4 KiBのrequest上限と回復ジャーナルを維持する。
- Agent/Skill/共通Markdownの共通writerにもNext拒否と変更観測を追加。Agent作成のmkdir、override/Skill更新のlock作成、削除も保存境界で保護する。Prompt transfer/formatの2実装をBackendへ移動し、Web互換exportを維持した。
- Phase2と定義管理は `configuration/commands.ts` の同じowner queue/ledgerを利用する。保存をcheckpointしてからBackendがlive reload/agent refreshを行い、applied/deferred/failed/not-requiredを明示する。fire-and-forgetの成功扱いは撤去した。忙しいセッションの反映保留は既存harnessのdeferred経路を使い、実行を中断しない。
- 保存成功・反映失敗は503でも `mutation.saved:true`・complete・保存revisionを維持。複合変更の一部失敗はpartial、同じoperationIdは再起動後も409で再実行を拒否する。結果は既存の `GET /api/settings?operationId=<id>` から読める。NextはACKのoperationIdを照合し、不正/喪失応答をunknownとして扱う。
- Agent編集GETの既存 `{draft,filePath}`、Markdown内容、Code/Bot別Skill設定、default Agent/必須Extension制約を維持する。公開外フィールド、reloadの例外本文、privateな復旧pathを応答に出さない。

### 第2区切りの検証結果

- 定義/関連helper・中継・Phase2設定回帰: 168/168成功。
- Core command・transport・AST ownership・Phase2境界・API inventory: 69/69成功。対象27経路・39操作が中継のみであることをASTで検証。
- Backend/Web typecheck成功。Backend強制ビルド6,820 KiB成功。Web typecheckの初回30秒timeoutとportable Request型の不一致を確認し、Backend transfer-accessの明示参照へ修正して再実行成功。
- Webなしの実Backend fixtureでMarkdown/Agent保存と読込、危険な名前の拒否、実プロセス再起動後の内容・同一receipt読込・重複受付拒否を検証（最終7.7秒）。稼働中ユーザーの定義・SOUL.md・サービスは変更していない。
- 全体Web/Backendスイートは第2区切りでは再実行していない。第1区切りの全体回帰集計を今回の全体通過として流用しない。

## 第3区切り: Provider/モデル設定（7経路・8操作）

- `models` GET、`providers` GET、`providers/[id]` PATCH、`providers/[id]/base-url` GET/PUT、`provider-models` GET、`provider-models/[key]` PATCH、`provider-models/order` PATCHをBackendのJSON業務APIへ移管。
- 対象Nextルートは中継returnのみ。アカウント状態・統合routing・モデル選択/effort/contextWindow/並び順・URL制約・CodexBar表示/直近throughput平均の業務判断はownerへ移動した。モデル/Providerの識別子は入口だけでURIデコードし、catalogの公開外SDKフィールドをネスト内も除去する。
- 設定/定義と同じqueue/ledger、opaque operationId/ACK照合、保存観測・partial保存・重複拒否・結果照会を利用する。Provider model state/endpoints/routingの共通writerはmkdir/一時ファイル生成前にNext書込みを拒否する。
- Native Provider API URLはruntime構築時の値であり、保存成功をlive反映済みと誤認させない。`mutation.apply:deferred`を返し、実反映は次回Backend起動。モデル設定/routingは既存の動的読込とcache invalidationを維持し、sessionの置換はnot-required。
- ProviderのOAuth/API-keyログイン開始・answer/callback/logoutは今回移管していない。Nextのlogin SSEと単一owner sessionの一体移管が必要であり、次の区切りに残す。認証完了・SSE移管を今回の成果として扱わない。

### 第3区切りの検証結果

- Provider/model domain・公開DTO・BFF・定義/設定互換の対象回帰91/91成功。
- pure contract・Core queue/ledger・transport・AST ownership・Phase2境界・API inventory79/79成功。対象累計34経路・47操作が中継のみであることをASTで検証。
- Backend/Web typecheck成功。Backend強制ビルド6,837 KiB成功。
- Webなしの実Backend fixtureでmodel contextWindowとAPI URLを保存、owner GET、実プロセス再起動後の内容と保存receipt照会を検証（8.1秒）。API URLの保存結果は再起動前deferredのまま履歴に保持し、過去receiptを書き換えない。稼働中ユーザーのアカウント・認証・設定・サービスは変更していない。
- 全体Web/Backendスイートは今回再実行していない。今回の対象回帰と以前の全体baselineを区別する。

## 第4区切り: Provider認証JSON（4経路・5操作）とログインSSE

- `providers/[id]/login` POST、`login/answer` POST/DELETE、`login/callback` POST、`logout` POSTをBackendへ移管。付随する `login/events` GETも `/internal/provider-login-events/<id>` を通じ同一Backend sessionへ中継する。
- 対象Nextルートは中継returnのみ。NextはSDK login/session/historyを保持・購読・取消しない。SSE切断/Next再起動はowner subscriberだけを切り離し、実行中ログイン・OAuth loopback listenerを止めない。sessionId/Provider一致、Peer accountのログイン/ログアウト拒否、callback入力上限、OAuth state/期限/重複callback制約はownerで維持する。
- JSON認証操作は独立したprivate admission ledger（0600・最大128件）にoperationIdとexecutionだけを記録する。入力値・コード・URL・資格情報は記録しない。handler実行前にunknownをcheckpointし、同じIDの再実行はowner再起動後も409で拒否する。受付記録失敗はnot-started、SDK/結果喪失はunknownで、自動再試行/fallbackなし。
- `operation.execution:complete`はJSON操作の応答完了であり、資格情報の保存・非同期ログイン成功を意味しない。保存成功/失敗はowner SSEのdoneで表す。設定変更用mutation.savedを認証開始/answerに流用しない。Backend自体の再起動では進行中のsessionは復元されず、古いsessionIdのSSEはdone失敗になる。
- SSEはowner側で公開DTOだけを投影し、秘密入力値・追加SDKフィールド・例外本文を出さない。認証画面で必要なOAuth URL/state・device code・promptは認可されたstreamで維持。done警告は「認証保存済み・モデル同期失敗」を維持するが、生のSDK例外は隠す。
- event 64 KiB、subscriber queue/socket 1 MiB、socket drain待ち45秒、入口handshake10秒で制限。過大/停滞subscriberだけを切断し、ログインはキャンセルしない。idle streamの切断も購読解除へ伝播する。Nextから直接harness mutation/ProviderLoginSession.runを起動する経路はowner guardで拒否する。

### 第4区切りの検証結果

- owner session・BFF・認証JSON・SSE・OAuth callback/secret prompt・共通SSE writer: 106/106成功。実ProviderLoginSessionを制御Runtimeで実行し、stream切断→再購読→同一promptへのanswer→隔離credential file保存→done、Provider/session取り違え、過大event、Next拒否を検証。
- admission/重複拒否・実HTTP stream/disconnect・pure contract・AST ownership・既存設定境界/API inventory: 94/94成功。JSON累計38経路・52操作とlogin SSE 1経路の中継だけの構造を検証。
- Backend/Web typecheck成功。Webのtest nullable session型は修正後に再実行成功。Backend強制ビルド6,857 KiB成功。
- Webなしの実Backend fixtureで認証入力拒否のACK、実SSE done失敗、実プロセス再起動後のoperation重複拒否を検証（13.2秒）。外部Providerへの実ログイン/OAuth grant・稼働中ユーザーの資格情報変更は実行していない。
- 全体Web/Backendスイートは今回再実行していない。対象回帰と過去全体baselineを区別する。

## 第5区切り: アカウント管理/資格情報（9経路・19操作）

- `accounts` GET/PATCH/POST、`accounts/[id]` PATCH/DELETE、`auth-status` GET、`anthropic-cookie` POST/DELETE、`anthropic-baseline` POST/DELETE、`ollama-cookie` POST/DELETE、`opencode-go-cookie` GET/POST/DELETE、`openrouter-baseline` POST/DELETE、`openrouter-credits` POST/DELETEをBackendへ移管。
- 対象Nextルートは中継returnだけ。Account CRUD/表示順・immutable Provider制約・実行中タスク/Goal Loop/lease/hang復旧時の無効化/削除拒否・管理キー削除前のアカウント削除拒否・Cookie検証/保存・基準残高・workspace設定・auth badge読込をownerが実行する。アカウントIDは1回decode後に安全な形式を検証し、Nextは業務入力を解釈しない。
- 設定/定義と同じconfiguration queue/ledgerとoperation ACKを利用する。Account一覧lock、Cookie/各private設定writerのmkdir/write/unlink前にNextを拒否し、秘密の保存観測hash/入力値をledger/応答へ出さない。Cookieは既存のアカウント別保存位置を維持し、private atomic replace（0600）へ変更した。削除はENOENTだけを成功とし、他のI/O失敗を隠さない。
- auth-statusはcredential種別・configured flag・baseline・peer flagだけ、一覧/編集はAccount公開フィールドだけをネスト内も投影する。Cookie・APIキー・管理キー・AuthStorage/raw SDKフィールド・private path・例外本文は返さない。OpenRouter JSONの破損はbaseline編集で上書きせず、明示的な管理キー再登録だけで修復する。Nextでの読込に伴うOpenRouter chmodも抑止した。
- idle peer削除時のpeer token除去とauth directory保持を維持する。OpenCode Cookie保存後のworkspace失敗はpartial保存として報告する。動的Account読込/usage/provider/health cacheの無効化を維持し、セッション置換を必要としない変更はnot-requiredとする。

### 第5区切りの検証結果

- Account API/owner/CRUD・BFFの対象回帰79/79成功。実Cookie/key保存と削除、auth-status、表示順/patch、Next common writer拒否、partial保存、破損設定の拒否/明示修復、private ledger非漏洩を検証。移動後の既存domain testはowner handlerへ接続し、実Next routeのopaque relay/ACK欠損/無書込も別途検証した。
- pure contract・configuration queue/ledger・transport・AST ownership・既存設定境界/API inventory100/100成功。対象累計47経路・71操作が中継だけであることをASTで検証。
- Backend/Web typecheck成功。Webの初回30秒timeoutは独立runnerで再実行成功（19.9秒）、最終直接実行も12.1秒で成功。Backend強制ビルド6,889 KiB成功。
- Webなしの実Backend fixtureでAccount作成・private key保存・auth-status、危険ID拒否、実プロセス再起動後のAccount/key/receipt読込、作成とkey書込の重複受付拒否を検証（8.6秒）。検証は隔離data/agent/APPDATAで実施し、実ユーザーのアカウント・資格情報・サービスは変更していない。
- 全体Web/Backendスイートは今回再実行していない。以前の全体baselineを今回の全体通過として流用しない。

## 第6区切り: 利用量/クレジット（3経路・5操作）

- `codexbar/providers` GET/PUT、`codexbar/usage` GET、`codexbar/reset-credits` GET/POSTをBackendへ移管。対象Nextルートは認可・bounded transportだけで、Provider表示設定/並び順・optimistic version・native usage/account scope/refresh・token telemetry・reset一覧/消費を実行しない。
- Provider設定は既存のprivate config/optimistic lockを維持し、設定queue/ledgerと保存観測を利用する。lock/mkdir/write前にNextを拒否する。別設定キーや既存enabled/order形式を保持し、cache invalidation後はnot-requiredを返す。
- usageのscope・paused account閲覧・shared/account/peer統合、provider concurrency=4、aggregate/inflight/per-provider cache・429 backoff・stale last-good・表示専用baseline・finalized-token telemetryを維持。利用量/credits/windows/token-estimate/accounts/catalog/reset DTOをネスト内も型付きで投影し、credentials・private path・任意SDK/configフィールド・生のProvider例外を返さない。Nextでnative polling/reset消費を拒否し、telemetryのreadでもSQLiteを開く/移行することを抑止する。
- reset POSTはprivate `usage-command.json`（0600・最大128件）にoperation ID/unknownを外部実行前にcheckpointし、結果complete/unknownを保存する。入力・credit ID・cookie・OAuth tokenはledgerへ保存しない。同じIDはowner再起動後も再実行しない。受付不能はnot-started、Provider応答喪失/5xxはunknownで、自動再送/fallbackなし。省略時の外部redeem request IDには同じoperation IDを渡す。
- `operation.execution:complete`はJSON操作完了であり、設定保存/credit消費を意味しない。消費結果は既存の`ok/code/message/windowsReset`で区別し、nothing_to_reset/no_credit等のHTTP 200・ok:falseを維持する。未知の結果から別IDで再試行する前にはProvider側のcredit状態確認が必要。128件の保持窓を超える恒久的exactly-onceを保証するものではない。
- account一時停止時の一覧/消費拒否、Claudeのaccount-only claude.ai cookie、OAuthの認証失敗、成功時のusage/provider cache invalidationを維持する。JSON null/array、未知Provider、危険account ID、過大/control-character credit/request IDをnative呼出前に拒否する。共通の自動reset処理は既存のowner scheduler/独立journalを維持し、手動操作用ledgerへ混同しない。

### 第6区切りの検証結果

- Native usage/API/owner/BFF/SQLite telemetry/Codex・Claude reset/既存auto-resetの対象回帰163/163成功。controlled Providerでcheckpoint-before-consume、同じ外部request ID、declined/unknown/replay拒否、account cookie、入力/paused拒否、deep DTO、Next共通呼出拒否を検証。
- usage contract/admission ledger・既存configuration/transport・AST ownership/API inventory111/111成功。JSON累計50経路・76操作が中継のみの構造を検証。admission ledgerの破損/Next拒否、owner再作成後の重複拒否と未知結果・秘密非保存を検証。
- Backend/Web typecheck成功。Backend強制ビルド6,925 KiB成功。
- Webなしの実Backend fixtureでProvider表示設定保存/版番号読込、scope/未知account拒否、消費入力拒否の実ACK/ledger、実プロセス再起動後の設定/receipt読込・消費重複受付拒否を検証（9.1秒）。実クレジット消費・外部OAuth grant・ユーザー設定/資格情報・稼働サービスの変更は実行していない。
- 全体Web/Backendスイートは今回再実行していない。今回の対象回帰と過去の全体baselineを区別する。

## 第7区切り: Peer認証共有（5経路・9操作）

- `peer-auth/peers` GET/POST/PATCH/DELETE、`peer-auth/import` GET/POST、`peer-auth/list` GET、`peer-auth/resolve` POST、`peer-auth/usage` POSTをBackendへ移管。対象Nextルートは中継returnだけ。grant/config/token永続化、remote discovery/import、limiter/audit、SDK refreshとcredential leaseをBackendが所有する。4つのowner helperをBackendへ移動し、Web互換exportを維持する。
- list/resolve/usageはPeer Bearerで認可する。WebUI Bearerとは独立し、内部Backend Bearerを置換せず、専用trusted headerだけでownerへ渡す。ブラウザーCookie/任意Authorizationは渡さない。管理は既存WebUI保護を維持し、importはWebUI認可必須。Originを維持し、Peer POSTを設定変更/operation admissionと誤認しない。
- Peer-facing本文は4 KiB。Nextは過大本文を有効な要求へ変換せず、ownerで認証後に不正本文を拒否する。401/403/400・scope・named account限定・rate limitとRetry-Afterを維持する。公開DTOは深く投影し、resolveの認可済みaccess/API-key leaseとgrant作成201の一度限りのtokenだけを明示例外とする。refresh/token hash/private path/例外本文は返さない。
- 管理/import変更は共通configuration queue/ledgerとACK照合・保存観測・同一IDの再実行拒否を利用する。ledgerに入力/tokenを保存しない。grant/store/config/remote probeにNext拒否を追加する。途中import失敗は作成済みAccountとpeer-token configを片付け、失敗した復旧を隠さない。応答喪失で一度限りのgrant tokenを再取得できない場合は、管理一覧でgrantを確認してrevokeしてから新規作成する。自動再送やtokenのledger保存はしない。

### 第7区切りの検証結果

- Peer API/domain/owner/BFFとAccount互換の対象回帰90/90成功。grant作成/有効化/revoke・秘密の非保存、Peer認証優先の本文検証、default/Provider scope拒否、制御RuntimeのOAuth refresh/lease、import/token保存/cleanup・WebUI認可とACK・Next共通拒否を検証した。
- Peer core/wire/contract・transport・AST ownership・既存設定境界/API inventory158/158成功。JSON累計55経路・85操作が中継だけの構造を検証。
- Backend/Web typecheck成功。Backend強制ビルド6,963 KiB成功。レビューでPeer-facing POSTの変更扱いが残ることを確認し、read-only/service分類へ修正して再検証した。初回owner回帰でimportが生WebUI tokenを要求する移管漏れを確認し、trusted configuration authorizationへ修正。OAuth制御Runtimeのmock接続も実際のgetRuntimeForへ修正し、全対象を再実行した。
- Webなしの実Backend fixtureでgrant hash保存/有効化、Peer list/API-key lease、default拒否、実プロセス再起動後の同じlease/重複作成拒否・metadata非漏洩/revokeを検証（最終8.2秒）。外部OAuth grant/本番credential変更・実ユーザーサービス再起動は行っていない。
- 全体Web/Backendスイートは今回再実行していない。対象回帰と過去の全体baselineを区別する。

## 第8区切り: Workspaceファイル/次タスク提案（3経路・3操作）

- `projects/[id]/files` GET、`tasks/[id]/files` GET、`projects/[id]/next-task` POSTをBackendへ移管。対象Nextルートは単一の中継returnだけで、登録Workspaceのroot/scope判定、ディレクトリ列挙/テキスト読取、Git snapshot/履歴・既存taskの組立、設定モデル/fallback選択と直接生成を実行しない。
- `project-files.ts` の実装をBackendへ移動し、Web互換exportを維持。登録済みproject/taskだけをrootとし、taskではproject rootを優先する。Bot/archived project・絶対/ドライブ相対/`..`/制御文字パス・root外symlink/junctionを拒否する既存制約を維持。一覧1000件/truncated、除外ディレクトリ、UTF-8検証と64 KiB上限、255コードポイントの添付名を維持する。共通FS/model実行入口にもNext拒否を追加した。
- 純粋なWorkspace wire contractで一覧/ファイルのラッパーなしpayloadとsuggestion/model identityを深く投影。ファイルは選択されたUTF-8添付だけをbase64で運び、size/文字形式/上限を照合する。追加SDKフィールド/資格情報/Provider例外本文は返さない。IDは1回decode後にownerで検証し、二重エスケープ名からrootを再解釈しない。
- 次タスク提案POSTは保存/command admissionではなくread-only/serviceに分類し、mutation/operation ACKを要求しない。80,000文字の既存本文制限にUTF-8のbyte上限320,000を併設。Origin/WebUI認可、Gitのargv/path/30秒/出力/同時capture上限、生成96 tokensと既存model timeout/fallbackを維持する。クライアント切断はGit request contextと生成AbortSignalへ伝播し、中止後にfallbackを起動しない。archived projectは生成前に拒否する。
- project CRUD/teardown、Explorer/icon、browse/dirsのBackend GET/Host POST混在境界は今回の範囲外。引き続きPhase3の未完了領域として扱う。

### 第8区切りの検証結果

- Workspace API/helper/direct generation/text/owner/BFFの対象回帰88/88成功。実隔離FSの列挙/UTF-8読取/1000件上限・サイズ/不正パス/symlink境界、task/project/archived/Bot scope、モデルfallback/公開DTO、Next実ルートの無書込/opaque転送/認可/body bound、制御Providerの生成中止とfallback不実行・共通Next拒否を検証。
- Workspace pure contract・Backend transport・AST ownership/API inventory・Backend build dependency境界83/83成功。対象累計58経路・88操作にNextの業務処理が残らないことを検証。
- Backend/Web typecheck成功。Backend強制ビルド6,985 KiB成功。
- Webなしの実Backend fixtureでregistered project/taskのファイル列挙と内容・root escape/二重エスケープID/不正UTF-8の拒否、モデル未設定の生成拒否、実プロセス再起動後の同じファイルpayloadを検証（7.8秒）。実Providerの有料生成・ユーザーworkspace/設定/資格情報変更・稼働サービス再起動は行っていない。
- 全体Web/Backendスイートは今回再実行していない。対象回帰と過去の全体baselineを区別する。

## 第9区切り: Project lifecycle（1経路・4操作）

- `projects` GET/POST/PATCH/DELETEをBackendの単一JSON業務入口へ移管。Nextは中継returnだけ。一覧/archived/ETag/icon URL投影、登録・restore・icon/color入力検証、archive/session停止・移動・削除をBackendが実行し、旧NextのlocalRuntimeBlocked分岐とteardown専用forwardを除去する。
- Project lifecycle専用のguarded entryを追加し、session停止/dispose・FS copy・store更新より前にNextを拒否する。既存Backend runtime entryのarchive/migrate/destroyもこの入口へ接続。共通AppStoreのproject writerとworkspace copyにもNext拒否を追加する。他セッション変更中のharness.tsは編集せず、他の未移管task store操作はこの変更で一律拒否しない。
- 変更はprivate `project-command.json`（0600・最大128件）のowner queueで実行前unknownをcheckpointし、同じoperation IDの再実行を再起動後も拒否する。入力/パス/icon/資格情報をledgerへ保存しない。応答喪失/5xx/結果記録失敗はunknown、自動再送/Next fallbackなし。`operation.execution:complete`はJSON操作完了であって、保存/移動/停止の原子性を保証しない。既存SDKのmigration rollback・非空/入れ子/重複destination/active task拒否・cleanup warningと既存teardown方針を維持する。
- 純粋なProject DTOを深く投影し、nullable/legacy metadataとwarningを維持し、SDK/秘密フィールドを除去する。valid raster iconの既存3,000,000文字上限を4 MiBのbounded transportで妨げない。Project削除は記録/所属task/session処理であり、ユーザーのproject directory自体の削除ではない。

### 第9区切りの検証結果

- Project API/owner/BFF・migration/promote・session停止/削除・runtime ownership回帰82/82成功。実隔離store/FSで登録/icon URL/ETag/archived/restore/migrate/delete、不正入力/非空destination/Next拒否/ACK欠損/重複拒否を検証。
- pure contract・project admission・AppStore/競合書込・transport・AST/API ownership98/98成功。累計59経路・92操作でNextの業務処理がないことを検証。
- Backend/Web typecheck成功。WebのBackend-only aliasとtestのnullable body型を修正して再実行した。Backend強制ビルド6,998 KiB成功。
- Webなしの実Backend fixtureで登録/icon/migrate/元copy除去/archive/restore、実再起動後のmetadata/重複作成拒否・delete後のdirectory保持を検証（最終7.7秒）。移動/削除検証は隔離workspace内だけで、実ユーザーworkspace/設定/資格情報/稼働サービスは変更していない。
- 全体スイートは今回再実行していない。対象回帰を全体成功と扱わない。

## 第10区切り: Task collection（1経路・3操作）

- `tasks` GET/POST/DELETEをBackendへ移管。Nextは中継returnのみ。注意一覧、孤児workingのreconcile、paneCandidates/titles/kind/archived/sidebar/ETag、Todo付きsummary、自動archiveをownerのstore/sessionで処理する。古いrelay switch・Next fallback・archive済み一括削除のlocal-by-design例外を除去する。
- 作成の入力/文字・画像・UTF-8添付/Goal設定検証、Autoモデル・account pin・並行Auto Agent選択、PermissionのSettings解決、createTaskを同じownerへ集約。3,000,000文字iconとは別に、既存12 MiB画像総量（base64 16 MiB）・64 KiB file・32k promptを妨げない18 MiBのbounded task transportを使用する。
- private `task-collection-command.json`（0600・最大128件）のowner queueがAuto選択/生成・session作成・一括teardownより前にunknownをcheckpointし、同じIDの再実行を再起動後も拒否する。入力/プロンプト/添付/資格情報は台帳に保存しない。受理後のwriteはclient disconnectで取り消さず、喪失/5xxはunknown、自動再送/Next fallbackなし。operation completeはJSON受付処理の終了であり、モデル生成成功・Taskの最終状態・一括削除の原子性ではない。GET時の既存自動archive方針は維持し、Nextで実行しない。
- 専用guarded entryとhandler/dispatcher入口はAuto/Agent選択、maintenance、session作成、bulk停止・削除より前にNextを拒否。既存Backend runtime entryのcreateTaskも専用入口へ接続。SDK本体は他セッション所有差分のため編集せず、他の未移管Task操作を一律拒否しない。
- Task metadata/Todo/Goal summary/responseModel、注意一覧、Auto decision/escalationを純粋DTOで深く投影。SDK・credential・初回添付・要求本文など未知フィールドを除去し、nullable legacy fieldsを維持する。一括削除は選択project/noProjectのarchived Codeだけを対象にし、Bot/active/別projectを保持する。
- 第10区切り時点で個別Taskのdetail/PATCH/DELETE/abort、message履歴・fork/promote等は未移管。この区切りはTask collection全体の閉包であり、Task全API完了とは扱わない。detail/PATCH/DELETE/abortは第11区切りで移管。

### 第10区切りの検証結果

- Task owner/Auto作成/Agent・account pin・Goal・添付/実BFF/SDK teardown・runtime ownership/auto-archive設定104/104成功。実隔離storeでkind/archived/attention/pane/sidebar/ETagとarchived-only bulk delete、入力/Origin/Next拒否を検証。作成成功とAuto/Agent選択は制御mockによる検証。
- pure contract/admission・AppStore/競合書込・transport・AST/API ownership99/99成功。累計60経路・95操作のNext transport-onlyを確認。
- Backend/Web typecheck、Backend強制ビルド7,016 KiB成功。途中のtest fixture型エラーと古いlocal-by-design期待値を修正して再実行。
- Webなし実Backend fixtureで実metadata/attention/pane、存在しないprojectへの作成拒否、archived-only bulk削除、実再起動後の保存状態と作成/削除operationの重複拒否を検証（8.2秒）。実有料生成/外部Agent選択・ユーザーTask/workspace/設定/資格情報変更・稼働サービス再起動なし。
- 全体スイートは今回再実行していない。対象回帰を全体成功と扱わない。

## 第11区切り: 個別Task lifecycle（2経路・4操作）

- `tasks/[id]` GET/PATCH/DELETE、`tasks/[id]/abort` POSTをBackendへ移管。Nextはparamsのtransport encodeとrelay returnだけ。旧localRuntimeBlocked/forward/local fallbackとBot所有者のローカル判断を除去する。
- 詳細取得/履歴page-size/ページング/omit/ETag、archive/restore/hard-delete、cold Goal Loop・Bot supervised Codeのabortをownerが実行する。Bot IDはownerのstore/outboxから解決し、callerの指定を使用しない。archive済みTaskとarchive済みprojectへのrestore制約、session/背景処理停止・Bot link整合を既存SDKのまま維持する。
- 単一decode後に安全なTask IDと既存`bot:<id>`を検証し、slash/二重encode/path escapeを拒否する。変更bodyは4 KiB。collectionの`task-collection-command.json`とowner queueを共有し、hydrate/store更新/停止/削除より前に入口でNextを拒否、変更はunknown checkpoint後に実行する。accepted操作はclient disconnectで取消し・自動再送しない。completeは停止・削除・model生成の原子性/成功を保証しない。
- getTaskDetailBounded/history-page-sizeをBackendへ移動しWebは互換exportだけ。30秒live budget→10秒offline budget→最終503の既存契約を維持する。レビューで旧Backend入口のread-only契約を確認し、新GETにも明示してcold GETによるsession生成を防止した。登録済liveは現在のowner snapshot、cold/他lease/archivedはtranscriptを読む。omitはhydrate optionに加えて最終messages空配列を保証する。
- 純粋TaskDetail DTOでmessages/parts/tool state/nested calls/Goal/Todo/context/permission/question/diagnosticsを深く投影し、SDK・credential・診断headers/stack等の未知フィールドを除去する。認可済みの会話text/thinking・添付・Goal本文/初回画像・tool input/outputはユーザーコンテンツとして維持する例外であり、tool inputのJSON再帰は64段上限。任意SDK objectの一般公開ではない。
- 既存Backend runtime entryのdetail/archive/destroy/cold abort/Bot stopもguarded入口へ接続。他セッションのharness.ts差分には触れない。message履歴/search/bookmark・prompt・fork/promote・Goal制御等は残る。

### 第11区切りの検証結果

- owner/実BFF・bounded timeout・cold read-only・restore/abort/archive/hard-delete・SDK session/背景作業停止・runtime ownership回帰88/88成功。実205-message transcriptでfull/page/omit、nullable DTO、ETag/304、directory/履歴file保持、archive済project拒否・不正ID・Next入口拒否を確認。Bot supervision/cold Goalの停止は制御SDK回帰を併用する。
- pure DTO/履歴/共有admission・TaskDetail source rules・transport・AST/API ownership102/102成功。累計62経路・99操作でNext transport-onlyを確認。途中の旧route guard件数と薄いhandlerのAST期待値を更新して再実行。
- Backend/Web typecheck、Backend強制ビルド7,026 KiB成功。
- Webなし実Backend fixtureで実205-message履歴full/page/omit、restore→cold read-only→abort→archive、実再起動後の履歴/状態とrestore重複拒否、hard delete後のtranscript file保持を検証（7.5秒）。実有料生成・ユーザーsession/Goal/Bot/資格情報変更・稼働サービス再起動なし。
- 全体スイートは今回再実行していない。個別Taskライフサイクル完了とPhase3全体完了を区別する。

## 第12区切り: Task履歴・検索・bookmark（3経路・5操作）

- `tasks/[id]/messages` GET、`search` GET、`bookmarks` GET/PUT/DELETEをBackendへ移管。NextはIDのtransport encodeとrelay returnだけ。履歴の設定page size・cursor検証、古いpageのbase64画像省略、全文検索・hidden retry除外・stable ID・snippet/highlight・最新hit上限、bookmarkの検証/保存/重複排除/並び順/削除/pruneをownerが実行する。
- `task-transcript`/`task-bookmarks`の正本をBackendへ移動し、Webは互換exportのみ。履歴/search/verifyは共通bounded read-only readerで登録済liveのowner snapshotまたはcold/foreign/archived transcriptを読む。cold sessionを生成せず、30秒primary/10秒offline/503の既存detail予算を維持する。searchは最大2件・3秒の既存read再利用、失敗は保持しない。verifyのmissingはbest effortで、読取失敗時には返さない。
- bookmark変更はcollection/lifecycleと同じprivate Task admission ledger/queueを使用し、受理前のunknown checkpoint、再起動後の同一ID拒否、ACK確認、送信後unknown、無自動再送/Next fallback、accepted操作のdisconnect非取消を維持する。operation completeはJSON処理の終了であり、メッセージの存在・Taskとの原子的更新を保証しない。既存4,000文字制限を維持する16,000-byte transport上限。認証/Origin/世代/readinessは共通入口、ownerもtrusted authorized contextとbyte上限を確認する。
- handler/reader入口とbookmark共通writerをguardし、Nextはcached transcriptにも到達できず、file lock/backup/保存前に拒否する。Bookmark ID alphabetなど既存制約は変更しない。SDK本体の他セッション差分には触れない。
- sharedの純粋契約でpage/messages/partsと検索hit/highlight、bookmark/missing/operationを深く投影。会話やpreviewなど認可済みユーザーコンテンツを維持し、SDK・credential・unknown fields/headersを除去する。画像省略は純粋shared helperをBackendと既存UIで共有する。

### 第12区切りの検証結果

- Task history/search/bookmark owner・実BFF・reader cache・旧UI履歴回帰60/60成功。実205-message transcriptのcursor/古い画像省略/全文検索/UTF-16 highlight、bookmarkのmissing・重複・削除、認証/Origin/不正body/byte上限/ID/Next writer拒否を検証。個別Task/collection/共有型/runtime ownership/bounded readerの関連回帰25/25成功。
- pure DTO/履歴/検索/bookmark store/共有Task admission・Backend transport・AST境界100/100成功。累計65経路・104操作がNext transport-only。途中の認可済context/byte上限のownerチェック不足、テストの無効operation IDを修正・再検証した。既存の有限timestamp互換性を投影でも維持する。
- Backend/Web typecheck、Backend強制ビルド7,050 KiB成功。Webなし実Backend fixtureで実205-message履歴2page/不明cursor/full search、bookmark追加/verify、実再起動後の保存・重複拒否・削除を検証（7.3秒）。
- 全体スイートは今回再実行していない。実有料生成・稼働ユーザーsession/サービス変更なし。第12区切り時点では53経路・78操作が残る。model/thinking/Agent・Goal Auto指定は第13区切りで移管。

## 第13区切り: Task実行設定（4経路・4操作）

- `tasks/[id]/model`・`thinking`・`agent` POST、`goal-loop-auto-model` PUTをBackendへ移管。Nextはparamsのtransport encodeと単一relay returnだけ。入力検証、model/accountの解決・pin、thinking適用、Agent変更/解除、Goal所有状態確認とAuto markerの保存/解除はownerが担当する。
- `task-execution-settings`の専用guarded入口を設け、Backend runtime entryの旧model/thinking/Agent呼び出しも接続。SDKのcold model切替・last responseModel保持・実行中/Goal queued時のpending settingsと次ターン適用、Agent transcript notice/再生成、thinking clampを維持する。他セッションのharness.tsは編集しない。
- 明示model変更の成功後にownerがGoal Auto markerを解除する。内部Auto-per-turnのSDK呼び出しはmarkerを解除しない。model変更失敗ではmarkerを維持し、model適用後に解除が失敗した場合はunknownの部分結果として扱い、modelをrollback/再実行しない。Auto有効化は所有中のGoalのcreatedAtへbindし、終了済みGoalも無効化できる。
- Task collection/lifecycle/historyと同じprivate admission ledger/queueで未知結果を実行前checkpoint。4 KiBの本文上限、単一decode/安全ID・trusted認可/Origin・readiness・Next guard、深いTaskSummary/account pin/nullable Agent/Auto booleanのDTOとoperation ACK、accepted操作のdisconnect非取消、無自動再送/ローカルfallbackを維持する。completeはJSON変更要求の終了であり、保留設定のSDK適用完了・Goal次ターン成功・model/markerの原子性を保証しない。

### 第13区切りの検証結果

- owner・実BFF・4 handler・runtime ownership53/53成功。model成功/失敗/marker解除失敗のpartial unknownと重複拒否、thinking/Agent変更・空文字解除、実Goal状態とmarker保存、認証/Origin/body/ID/Next拒否・DTO秘匿を検証。SDK Agent/model selection回帰41/41成功、routingのmodel/明示pin/Goal deferred・Auto identity対象12/12成功（残る82ケースは対象外skip）。
- pure contract・共通Task admission・Backend transport・AST境界84/84成功。累計69経路・108操作でNextに業務処理が残らないことを確認。
- Backend/Web typecheck、Backend強制ビルド7,057 KiB成功。Webなしの実Backend fixtureで到達不能なfixture専用modelをcold選択、実SDK sessionのthinking変更、Agent空選択、Goal marker保存・実再起動後のmodel/marker保持・重複拒否・Auto解除を検証（8.8秒）。モデル生成・外部資格情報/稼働サービス操作なし。
- 広いSDK routing再実行は30秒上限で中断。soft accountId作成の待機timeout 1件は単独でも再現。原因の分離: 変更前`7c9abd4f`を隔離した同じテストは成功、同HEADへ開始時の他者差分7ファイルだけを加えると失敗した（第13区切りの変更は一切含まない）。他者差分を保持し、今回のコミットへ混ぜない。全体スイート成功とは扱わない。
- Web型チェックで検証mockのThinkingLevel型を修正し、型チェック/関連47件を再実行成功。第13区切り時点ではprompt・Goal制御・fork/promote/revert等49経路・74操作が残る。

## 第14区切り: Task送信・対話応答（3経路・3操作）

- `tasks/[id]/prompt`・`permission`・`question` POSTをBackendへ移管。Nextはparamsのtransport encodeと単一relay returnだけ。本文/添付の検証、Auto model/Agent・account/再開/steer選択、SDK送信、pending permission/questionの所有Task・FIFO先頭確認と回答/拒否はownerが担当する。
- 既存ownerの`handleTaskPrompt`を正規入口とし、Next roleを本文検証・会話読取・Auto推論前に拒否する。Backend runtime entryの旧prompt/permission/question呼び出しにも専用guarded wrapperを接続する。SDKのprepare/Stop取消・送信queue・Bot委譲先のattention解決・expired requestの404を維持し、稼働中の他者harness変更には触れない。
- `task-conversation-command.json`にprivateな128件上限の受付ledgerを設ける。check/replay拒否/unknown checkpointを一つのfile-lock内で実行するが、handlerを全体queueへ入れない。Auto/SDKの送信準備が未完了でも回答・既存Stopは独立して実行できる。unknownを保持してcompleteだけを間引き、全件unknownなら新規受付をnot-startedで拒否する。exactly-onceや無期限の重複履歴保持を保証しない。
- ledgerにはoperation ID/uncertaintyのみ保存し、本文・添付・approval・回答は保存しない。completeは送信/応答要求の受付処理終了であり、生成完了・tool実行成功・複合操作の原子性ではない。accepted操作はdisconnectで取消せず、重複/再起動後replay・Next fallback・transport自動再送を拒否する。SDK既存の内部queue/retryとは区別する。
- prompt 18 MiB、permission 4 KiB、question 16 KiBの実byte上限。trusted認可/Origin/readiness/世代/安全ID/単一decode、Task/Auto decision/escalationの深い公開投影、ACK一致確認を維持する。HTTP本文のfromBot/codeRequestId/waitForCompletion/permission等の内部指定はSDKへ渡さない。正しいACKの送信受付後だけWeb内のopen streamをwakeする。

### 第14区切りの検証結果

- 対象Web/owner/handler/SDK service/prepare/実BFF/ownership回帰106件、Core/契約/transport/AST/runtime bundle125件が成功。独立fixture1件を含め、重複を除く対象232件を検証した。送信準備中の実Stop・回答、disconnect後の継続、実pending serviceのTask/FIFO照合・approval/denial/answers/reject/expired、unknown/重複・満杯ledger、秘匿と内部権限指定の無視を確認。
- Backend/Web typecheck、Backend強制ビルド7,067 KiB成功。Webソース/パッケージのない実Backend fixtureで、到達不能なlocalhost専用modelへの実SDK送信受付、期限切れpermission/questionの404、ledger非記録、実プロセス再起動後の3操作replay拒否を検証（10.0秒）。生成成功や実tool実行の検証とは扱わず、有料Provider・稼働ユーザーTask/資格情報/サービスへ操作していない。
- 原因: 境界テストの古い期待値。Next SDK入口数の23→20を反映し、collection専用matcherと既に移管済みの個別Task matcherを区別した。後者の古い期待値と既存Task lifecycle matcherは開始時HEADにも存在したことを確認し、関連テスト再実行で成功。Web typecheckが検出したowner handlerのaliasと検証fixtureのDTO型も修正済み。
- 全体スイートは今回再実行していない。第13区切りで分離済みの他者差分のみで再現するSDK routing待機timeoutを今回解消したとは扱わず、開始時の7ファイルを保持する。第14区切り時点ではGoal制御・fork/promote/revert・compaction・Bot業務等46経路・71操作が残る。

## 第15区切り: Goal制御（2経路・4操作）

- `tasks/[id]/goal-loop` GET/POST/PATCHと`goal-loop/active` GETをBackendへ移管。Nextはparamsのtransport encodeと単一relay returnだけ。Goal/acceptance/画像・予算の検証とclamp、Auto/model/account/Agent選択、開始・pause/resume/stop/complete、Bot委譲元の解決、状態ファイルとlive inventoryの読取はownerが担当する。
- Goal GETは必ずSDKのoffline読取を使い、cold Taskでもsessionを起動せず、見つからないloopはnull、Task不在は404を返す。activeはownerのlive/persisted queued/running/verifying一覧を返し、失敗を空リストに偽装しない。読取にもNext拒否をSDK/cache/FSより前に設ける。
- canonical `startGoalLoopWithSelection`とBackend runtime entryのGoal state/command/activeにowner guardを追加する。開始選択のbusy判定・prepare/Stop取消・Auto再解決・既存best-effort設定rollback、resumeのlate verified completed、制御後のdurable状態照合を維持する。Bot-owned CodeのStopはcallerのbotIdを無視し、ownerで実際の委譲元を解決してoutbox停止経路へ接続する。
- Goal専用`task-goal-loop-command.json`は第14区切りのconcurrent admission実装を再利用する。開始準備中も制御を受付可能で、実行前unknown checkpoint、同一IDの再起動後replay拒否、unknown保持/complete間引き、disconnect非取消を維持する。completeは要求処理の終了であり、Goal生成・全設定のrollback・原子的保存・無期限exactly-onceを保証しない。
- startは画像互換の18 MiB、PATCH controlは4 KiBに分け、Next/Backend両transportもHTTP methodに基づく実byte上限を確認する。Goal/progress/initialImages・Agent・Auto decision/escalation・active taskIdsの純粋な深い公開DTOとACK一致を検証し、任意SDK/資格情報/ヘッダーを除去する。GET nullは保持し、POST/PATCHのnull成功は不正応答としてunknownにする。HTTPのrestartPrompt等の内部指示はSDKへ渡さない。

### 第15区切りの検証結果

- owner/2 handler/実BFF/ownership64件、関連SDK command/state/settings・Task lifecycle/conversation52件、Core/契約/transport/AST101件、独立fixture1件、重複なしの合計218件が成功。既存Goal拡張をreal SDK/faux providerで実行する18ケースも全件成功し、retry/lease/verification/reload/host routingを確認。全体スイートは今回再実行していない。
- Backend/Web typecheckとBackend強制ビルド7,073 KiB成功。Webソース/パッケージのない実Backend fixtureで、fixture専用の無生成SDK Goal command拡張をロードし、開始→pause→resume→complete→stop、offline状態/active読取、durableファイル保持・深い秘匿・ledger非記録、実再起動後の状態とstart/resume replay拒否を検証（14.3秒）。fixture制御自体は生成やtool実行を行わず、実有料Provider・稼働Task/資格情報/サービスに触れていない。
- 原因: 検証fixtureの誤った仮定。GETへ本文を付けず、24時間上限内のcooldown=5,000秒は維持する既存仕様へ期待値を修正し、関連テスト再実行で成功。Next SDK入口の実測数を20→19に更新した。
- 開始時の他者差分7ファイルを保持してコミットへ混ぜず、第13区切りで分離済みのSDK routing待機timeoutを解消したとは扱わない。第15区切り時点ではPhase3全体は未完了で、fork/promote/revert・compaction・進行補助・Bot業務等44経路・67操作が残る。

## 第16区切り: Task会話編集・昇格（4経路・4操作）

- `tasks/[id]/{fork,revert,unrevert,promote}` POSTをBackendへ移管。Nextは単一relay returnとparamsのencodeのみ。entryId/destinationPathの検証、会話ツリーの分岐/巻戻し/復元、プロジェクト登録・workspaceコピー/最終削除・session再接続はownerが実行する。
- `lib/task-session.ts`の専用owner guardをHTTP処理とBackend runtime entryへ接続する。NextをSDK/cache/FS操作前に拒否し、並行変更中のharnessは編集しない。既存のactive-branch/legacy ID解決、idle/attention/lease/prepare/tree-edit保護、Goal停止、復元marker、fork rollback、昇格先lockとコピー失敗のrollback・部分成功warningを維持する。
- 全4操作を4 KiBの実byte上限・純粋な深いdraft/attachment/TaskDetail/Project DTOで保護する。HTTPからentryIdかdestinationPathだけを渡し、任意Bot/SDK内部指示を実行しない。公開外SDK/資格情報/ヘッダーを除去し、NextはoperationId一致を必須にする。不正なSDK成功DTOはownerのcheckpoint前に503/unknownとして扱う。
- 専用`task-session-command.json`はconcurrent admission、実行前unknown checkpoint、128件のunknown保持/complete間引き、再起動後の同一ID拒否、disconnect非取消を再利用する。別Task/control/回答をworkspaceコピーの後ろへ並べない。completeは要求処理の終了であり、原子的移動・rollback成功・無期限exactly-once・selected-leaf永続化を意味しない。

### 第16区切りの検証結果

- owner/4 relay handler/実BFF/ownership52件、既存fork/revert/promote/workspace移動55件、Core/契約/HTTP transport/AST/bundle112件、独立fixture1件、重複なしの合計220件が成功。全体スイートは今回再実行していない。
- Backend/Web typecheck、Backend強制ビルド7,092 KiB成功。Webのない隔離実Backendで100件の祖先だけを分岐し、元ファイル不変、巻戻し→復元、実workspace/SessionManager昇格・元workspace削除・保存後の実再起動、全4 operation IDのreplay拒否、cold復元markerの消去、移動先ファイル保持とledger非記録を確認（10.5秒）。有料生成・実tool実行・稼働ユーザーTask/資格情報/サービスへの操作は行わない。
- 原因: 旧境界期待値とfixture前提。Next SDK入口19→16を反映し、Web typecheckの新owner alias参照を相対参照へ修正。事前fixture workspaceのmkdirを再帰化し、state-only Goal command後は実Stopでleaseを解放してからforkする。
- 既存制約（今回未修正）: SDK `branch()/navigateTree()`は次のappendまで選択leafをメモリ内だけで保持するため、巻戻し後に何もappendせずBackendを再起動すると旧branchの履歴へ戻る。実fixtureで100→50→再起動100を観測し、SDK実装を確認した。保存済みundo markerと再起動後の復元/marker消去は確認済み。選択leafの永続化を本移管の成功条件・成果として偽装しない。
- 開始時の他者差分7ファイルを保持し、既存SDK routing待機timeoutを解消したとは扱わない。第16区切り時点ではPhase3全体は未完了で、compaction・進行補助・supervisor・Bot業務等40経路・63操作が残る。

## 第17区切り: Task compaction（2経路・2操作）

- `tasks/[id]/compact`と`tasks/[id]/compact/abort` POSTをBackendへ移管。Nextは単一relay returnとparamsのencodeのみ。入力の形/型・32,000 Unicode code points上限、圧縮/取消・SDKモデル選択/設定・checkpoint・Task詳細はownerが担当する。開始の`maxDuration=300`と5分の中継timeout、中止の既存10秒timeoutを維持する。
- 開始はJSON control escapeの最悪値192,000 bytesも許容する192 KiB、中止は4 KiBの実byte上限。ASCII/日本語/絵文字/制御文字の最大値と超過を検証し、Nextでfocusを解釈しない。HTTPのmodel/account/Agent/Bot/内部権限指定はSDKへ渡さず、既存の設定済みsummarizer・single-pass・Jev/モデルfallback・history不足/既圧縮/取消/busy拒否を維持する。
- 専用`lib/task-compaction.ts`とBackend runtime entryにowner guardを設け、Nextをcold session生成/cache/FS/model/abortより前に拒否する。中止はcold Taskをhydrateせず、live session不在は404。専用`task-compaction-command.json`のconcurrent admissionにより、圧縮がprovider待機中でも中止を受付する。128件ledger、実行前unknown checkpoint、再起動後replay拒否、disconnect非取消とACK照合を再利用する。
- 深いTaskDetail/summary/checkpoint UIとisCompactingを投影し、任意SDK/資格情報/ヘッダーを除去する。不正なSDK成功DTOはcheckpoint前に503/unknown。completeは要求処理の終了であり、abort後に非協調providerが終了したことや原子的保存・無期限exactly-onceを保証しない。abort ACK時にisCompacting=trueでも既存SDK状態を保持し、偽の完了へ書き換えない。

### 第17区切りの検証結果

- owner/2 relay handler/実BFF/ownership50件、SDK/controller/モデル/Jev/single-pass58件、Core/契約/HTTP transport/AST/bundle111件、独立fixture1件、重複なしの対象220件が成功。全体スイートは今回再実行していない。
- Backend/Web typecheck、Backend強制ビルド7,097 KiB成功。Webなしの隔離実Backend/SDK/ローカルSSE responderで、cold abort404・provider待機中の実中止・socket切断・取消400・取消時checkpointなし、その後の圧縮成功・focus反映・1件のSDK checkpoint保存とUI表示・ledger非記録・実再起動後のsummary/非圧縮中状態・開始/中止双方のreplay拒否を確認（11.1秒）。応答はfixture専用の固定textで、有料/外部生成・実tool実行・稼働ユーザーTask/資格情報/サービスへの操作は行わない。
- 原因: 境界検証の既存SDK入口数が移管後に減少するため、16→14と対象ルート一覧を更新した。レビューで検出したtestの行末空白を除去し、差分検査と対象テストを再実行した。
- 並行差分7ファイルと第16区切りで記録したSDK selected-leaf永続化の既存制約を保持する。既存SDK routing timeoutを今回解消したとは扱わない。第17区切り時点ではPhase3全体は未完了で、進行補助・supervisor・Bot業務等38経路・61操作が残る。

## 第18区切り: Task進行補助（4経路・5操作）

- `tasks/[id]/progress`、`next-action`、`permission/advice` POSTと`title` POST/PATCHをBackendへ移管。Nextは単一relay return/params encodeのみ。入力解釈・読み取り専用live/offline進捗snapshot・履歴digest・候補/effort/アカウントpin/fallback・ローカルLLM競合回避・タイトル/ラベル判定と保存をownerが担当する。
- `lib/task-assistance.ts`と全owner handler/dispatcherでNextを会話/設定/FIFO/FS/model/永続化より前に拒否する。progressはエージェント会話/Goal/ToDo/作業記録を参照するだけで、質問/回答を会話へappendせず、cold sessionをhydrateしない。次の一手は履歴/既存提案から生成する。権限助言はownerのpending FIFOとrequestIdが一致する場合だけ、そのコマンドをデータとして助言する。callerのcommand/allow/model/内部権限では承認・拒否・コマンド実行へ進まない。
- 元のraw UTF-16上限をownerに保持（progress/title 8,000、next-action 80,000）。中継のbyte上限は32,000/320,000、permission adviceは4 KiB。深いTaskSummary/model/既存source・生成回答・suggestions・question/snapshotAt/working・label-onlyの未判定結果を投影し、任意SDK/資格情報/ヘッダーを除去する。
- 専用`task-assistance-command.json`のconcurrent admissionで生成候補待機中も手動編集/Stop/回答を塞がない。128件・実行前unknown checkpoint・ACK照合・restart replay拒否を保持。不正な成功DTO/5xxはunknown/汎用エラーとなる。completeは要求処理終了であり、原子的タイトル/ラベル更新、後続Jevラベル判定の終了、無期限exactly-onceを保証しない。
- progressだけは元のブラウザ切断取消と120秒全体deadlineを維持するため、内部HTTP/dispatcherのsignal選択を当該経路に限定して追加した。他の生成/タイトル保存と既存mutating APIは受付後の切断で自動取消・再実行しない。進捗生成は取消後もunknownとしてreceiptを保持する。

### 第18区切りの検証結果

- owner/4 handler/実BFF 74件、direct-title/generation/text/session/進捗digest/ownership111件、Core/契約/HTTP/AST/bundle121件、独立fixture1件の対象307件が成功。既存handlerの業務テストはBackend handlerへ向け替え、Nextは実BFFとASTで検証した。全体スイートは今回再実行していない。
- Backend/Web typecheck、強制Backendビルド7,145 KiB成功。Webなし隔離実Backend/SDKと専用ローカルSSE responderで、進捗/次の一手/タイトルの固定日本語生成、label-only、expired permission404、実HTTP切断からprovider socket閉鎖、手動タイトルsanitize/auto-update opt-out保存、会話ファイル非変更、ledgerへの入力/出力非記録、実再起動後のタイトル復元と全操作replay拒否を確認（11.8秒）。取消はunknown、他の完了要求はcompleteを検証する。固定textのみのfixtureで、有料/外部生成・tool実行・稼働ユーザーTask/設定/資格情報/サービスへの操作は行わない。
- 原因: 新規owner testのfixtureを`never`とした型指定によりobject spreadがWeb typecheckで拒否された。Task record型へ修正し、型チェックと対象74件を再実行した。レビュー後に実fixtureの取消receiptがunknownであることも明示検証した。
- 並行差分7ファイルと既存SDK routing timeout/selected-leaf永続化制約は保持し、今回解消したとは扱わない。第18区切り時点ではPhase3全体は未完了で、Task supervisor/subagents・Bot業務等34経路・56操作が残る。

## 第19区切り: Task監督/子実行（2経路・2操作）

- `tasks/[id]/supervisor` POSTと`tasks/[id]/subagents` GETをBackendへ移管。Nextは単一relay return/params encodeのみ。委譲/解除の判断・Bot選択/権限・Code起点/既存監督/busy状態・outbox/通知・登録済み親セッションの子artifact検索/since判定はownerが担当する。
- 専用`lib/task-supervision.ts`と全handler/dispatcher、Backend runtime entryの委譲/解除exportにowner guardを設け、NextをSDK/relay/outbox/metadata/FS/cacheより前に拒否する。入力`botId:null`は解除、非空の安全な128文字以内IDはtrim後に委譲する。callerの内部権限/action/command等は使わず、既存SDKがenabled/deny/Code起点/別Bot監督/実行中条件を検証する。解除は監督outboxをcancelし、Code本体の生成・圧縮を止めない。
- POSTは4 KiB上限と専用`task-supervision-command.json`のconcurrent admission。通知待機中も解除/Stop/回答を一括queueしない。128件・実行前unknown・ACK照合・disconnect非取消/replay拒否を保持する。不正な成功TaskSummaryは503/unknown。completeは要求処理終了であり、Botへの通知/結果配送完了やリンク/outboxの原子的保存・rollback・無期限exactly-onceを保証しない。
- GETはledger/SDK hydrationなし。Taskの登録済みsessionFile/directoryだけで検索し、クライアントのpath指定を無視する。既存1,000,000 byte tail・最大8 run・128-entry cache・temp artifactのparentSessionKey照合・since数値判定・running/completed/error/stale判定を維持する。深いUiMessage/思考/ツール状態/任意のユーザーtool inputは保持し、任意SDK/資格情報/ヘッダーを除去する。不正なrun/応答やBackend不通を偽の空配列で隠さない。

### 第19区切りの検証結果

- owner/2 handler/実BFF50件、Bot relay/並行outbox/子transcript/UI polling/ownership127件、Core/契約/HTTP/AST/bundle175件、独立fixture1件の対象353件が成功。全体スイートは今回再実行していない。Backend/Web typecheck、強制Backendビルド7,152 KiBも成功。
- Webなし隔離実Backend/SDKで、実compaction provider待機中のuser Codeをfixture Botへ委譲→1件のdurable supervision outbox/リンク→解除→outbox cancel/リンク解除と圧縮継続を確認。実再起動後の解除状態/outbox/replay拒否、fixture child transcriptの思考/会話/current tool・since除外・再起動後の一覧復元・親会話非変更も確認（11.8秒）。Bot通知は到達不能localhostモデルのみ、圧縮/進行補助は既存固定text responderのみ。有料/外部生成・子エージェント起動/tool実行・稼働ユーザーTask/Bot/設定/資格情報/サービスへの操作は行わない。
- 並行差分7ファイルと既存SDK routing timeout/selected-leaf永続化制約は保持し、今回解消したとは扱わない。Phase3全体は未完了で、Bot lifecycle/会話/Code/routine/Room業務等32経路・54操作が残る。

## 第20区切り: Bot lifecycle

- `bots` GET/POST、`bots/[id]` GET/PATCH/DELETEをBackendへ移管。Nextはencoded IDと単一中継returnのみで、設定読取・テンプレート選択・入力検証・セッション更新・永続化・teardownを持たない。古い一覧のlocal fallback、個別adminのlocal/forward分岐を除去した。
- guard付きの一覧/作成/個別取得入口と既存admin入口がNextをSDK/store/FSより前に拒否。作成はownerのpermission/thinking設定、既存Core既定値、7件の純粋shared template catalogを使用する。callerのmodel/permission/approval/directory/SOUL等は作成引数に採用しない。既存Coreの新規Bot `codeAutoApprove:true` は変更せず、特権PATCHは認証済みcontextをownerで再確認する。
- 一覧はworking CodeのbotId優先件数とETag/304を維持。個別GETのlegacy tool移行/既にliveな設定反映はownerで行い、cold conversationをhydrationしない。Bot DTOはskills/tool/rootsを含め深く投影し、認可されたSOUL/画像/設定とnullable/optional fieldsを保持、private SDK/credential/headerを除く。読取失敗・不正successを空一覧に偽装しない。
- PATCHは既存model/thinking/permission/tools/skills/SOUL更新、disable/resetのRoom/Code/Goal停止を維持。DELETEはRoom runtime離脱・所属解除・outbox/linked Code停止・owned Task破棄・残るsupervised Taskの監督解除・Bot directory除去を同じownerで順に実行する。ユーザーのCode workspace/他Bot/Room会話を削除しない。
- private `bot-lifecycle-command.json`（0600・最大128件）の直列CRUD admissionがunknownを効果前に記録する。入力/設定/名前/SOUL/画像は記録しない。同じIDは再起動後も409、ACK一致必須、受付不能はnot-started、部分保存後SDK例外/5xx/不正successはunknownで自動再実行/fallbackなし。admission後のbrowser切断でteardownを取消さない。completeはJSON処理終了であり複数file/store/session更新の原子性やrollback保証ではない。
- 作成/削除は4 KiB、PATCHは4 MiB。既存avatar最大3,000,000文字とSOUL最大128 KiB（UTF-8）を併用でき、最大SOULのJSON control escapeも通す。IDは一度だけdecode、既存UUID-shaped形・最大128文字でpath/double-encoding escapeを拒否し、sidebar/events/roomsを個別Bot経路へ吸い込まない。

### 第20区切りの検証結果

- owner/2 handler/実BFF73件、Bot store/SOUL/Code relay/並行outbox/ownership127件、Core/契約/HTTP/AST/bundle164件、独立fixture1件の対象365件が成功。全体スイートは今回再実行していない。Backend/Web typecheck、強制Backendビルド7,173 KiB成功。
- Webなし隔離実Backendでtemplate Bot作成→owner一覧/ETag/個別cold読取→名前/tools/skills/roots設定保存→実プロセス再起動後の復元、3 command IDの再実行409を確認。別fixture Bot削除はlinked Code/owned Task除去・残るTaskの監督解除・Room所属解除・他Bot/Room会話/Code workspace保持まで実検証（11.9秒）。最大avatar+escaped SOULと保存後SDK例外によるunknown/partial-save/replay拒否もowner検証した。
- 有料/外部生成・実OAuth・稼働ユーザーBot/Task/設定/資格情報/SOUL/サービスへの変更なし。並行差分7ファイルと既存routing timeout/selected-leaf永続化制約は保持する。Phase3全体は未完了で、Bot会話/Code/routine/sidebar/Room業務等30経路・49操作が残る。

## 第21区切り: Bot会話（3経路・3操作）

- `bots/[id]/prompt・abort・revert` POSTをBackendへ移管。Nextはparams encodeと単一relay returnのみ。Bot読取、prompt/images/UTF-8 files/合計添付件数、Goal選択・clamp/busy判定、SDK送信/停止/tree編集/outbox取消はguard付きowner入口が担当する。Goal共通入口にもBot/store/SDK読取前のguardを追加した。
- 送信のcaller内部権限/model/taskId/botId/action/codeRequestId等をSDKへ採用しない。Goalにはacceptance/maxTurns/cooldownSeconds/forceFullRun/imagesだけを選択し、既存のfile添付禁止を維持。通常送信の2/3/4引数互換、最大18 MiB、Stop/revert各4 KiBを保持する。UUID-shaped Bot IDはdecode一回で検証、revert entry IDはtrim/256文字以内/control拒否。
- Stopは既存の実Backend `stopBotCodeTask(botId, botTaskId(botId))` を使用し、matching outboxのuser-stopとcold/live Goalを含む中止を維持。revertはSDK tree編集成功後だけ1:1-origin outboxを取消し、同じBotの別Room業務には触れない。編集後の取消例外はtyped 4xxであっても503/unknownへ変換し、安全なrefusal/rollbackを偽装しない。
- private `bot-conversation-command.json`（0600・最大128件・入力/会話/添付非記録）のconcurrent admissionで、session/Goal準備・tree編集中もStopをqueueしない。効果前unknown、ACK一致、再起動後同ID409、admitted disconnect非取消、無fallback/自動再送を維持。completeは要求処理終了であり生成完了・配信完了・複数file/tree/outboxの原子性・無期限exactly-onceではない。
- TaskSummary/Goal/巻戻しdraft・添付・UiMessageを深く投影し、author text/思考/ツール入力を保持、任意SDK/credential/headerを除外する。不正な成功DTOは503/unknown。成功Bot promptのACK後だけ `bot:<id>` のBackend Task listenersをwakeする。

### 第21区切りの検証結果

- owner/3 handler/Goal helper/実BFF85件、Bot Code relay/SDK Goal/rewind/Task prompt/owner/ownership161件、Core/契約/HTTP/AST/bundle/build213件、独立fixture1件の対象460件が成功。全体スイートは今回再実行していない。Backend/Web typecheck、強制Backendビルド7,183 KiB成功。
- Webなし隔離実Backend/SDKでBot providerを実SSE待機→Stopで接続中止、UTF-8 file付き普通送信→固定日本語応答、既存user entryへの巻戻し→1:1の未起動outbox取消/別Room outbox保持、次prompt append後の新branch永続化、state-only Goal開始→Stopを検証。実プロセス再起動後も新branch/日本語応答/Room outboxを保持し、7 command IDの再実行を409で拒否した（12.1秒）。
- Bot responderはlocalhost固定textのみ、3要求（待機1・正常応答2）。SDKは組込toolを宣言し得るが応答でtool callを返さず、sessionのtoolCall/toolResult非存在も確認した。Goalはfixture extensionによるstate-only SDK commandでprovider要求を増やさず、有料/外部生成・Code/子agent起動・tool実行・稼働ユーザーBot/Task/設定/資格情報/SOUL/サービスへの操作はない。
- 原因: 初回7件のpromptテスト失敗はmockがtyped 400/409を500へ潰したため。ownerへ移した本番validationは保持し、mockを実status対応に修正した。ownership期待値は移管済み3経路を除外し14→11へ更新。レビューでSDK編集後のtyped outbox refusalを検出し、503/unknown化と再実行拒否を検証した。
- 並行差分7ファイルと既存routing timeout/selected-leaf制約を保持する。巻戻しだけのleaf永続化を追加したものではなく、fixtureは次prompt append後のbranch復元を検証した。Phase3全体は未完了で、Bot Code/routine/sidebar/Room業務等27経路・46操作が残る。

## 第22区切り: Bot Code（2経路・5操作）

- `bots/[id]/code-session` GET/POST/PATCH、`bots/[id]/code-requests` GET/POSTをBackendへ移管。Nextはparams encodeと単一relay returnのみ。旧local/forward分岐、Bot/Project/Task判断、orphan reconcile、Goal設定解釈、SDK開始/継続/停止、link/outbox更新、progress peek・ETag生成をownerへ集約した。
- 全handler/dispatcherと専用 `lib/bot-code.ts` のSDK入口をguardし、NextをSDK/store/cache/FSより前に拒否する。POSTは既存のProject有効性・Bot deny/disable・prompt/model/thinking/permission・Goal acceptance/clampを検証。callerのbotId/taskId/codeRequestId/beforePrompt/images等は開始引数へ採用せず、ownerがoutbox ID/起点/Code taskを生成する。
- PATCHはlinked task/明示taskIdをownerで解決し、1:1のowned/supervised Codeだけを操作する。Room worker/Room-delegated Code/他Botを拒否。prompt継続はdeny/disableを拒否、Goal resumeはdisableを拒否し、pause/stop/complete/abortは無効化後も使用できる。Goal Stopはoutboxをuser-stoppedにし、unlinkはworking/cold operator-held Goalまで停止→再確認後にだけmatching Bot/監督linkを解除する。停止不能409はlinkを保持し、別のCode linkを消さない。
- request Stopは64文字のlowercase hex IDとBot所有を検証し、当該outboxだけuser-stoppedにする。実Codeが開始済みの場合はcold/live Goalを含むabortを行い、finallyで生成済み結果を回収する。途中のabort/回収例外や部分的link更新例外はtyped 4xxであっても503/unknownへ変換し、成功済み効果をrefusal/rollbackとして扱わない。
- 専用 `bot-code-command.json`（0600・最大128件・入力/設定/Task ID非記録）のconcurrent admissionでCode launch/継続を待たずStopを受ける。効果前unknown、ACK一致、admitted disconnect非取消、同ID再起動後409、無fallback/自動再送を保持。completeは要求処理終了でありCode生成/結果配送終了やstore/Bot/outboxの原子性・無期限exactly-onceの保証ではない。
- GETのpanelはBot-scoped既存summary/Goal/todo取得、requestsは既存非intervention一覧/順序とactiveだけのprogress peekを保持。cold pollingでlive sessionを新規attachせず、GETにcommand ledgerを書かない。Task/Goal/進捗・結果reportを深く投影し、author text/output/acceptance/evidence・legacy plain resultを保持、SDK/credential/header/任意reportフィールドを除く。不正成功を空一覧に偽装せず503。ETag/304も維持する。
- Code session本文は256 KiBで既存32,000 code-point promptの最大UTF-8/JSON control escapeとGoal optionsを収容、request Stopは4 KiB。Bot IDはdecode一回・既存UUID-shaped検証。

### 第22区切りの検証結果

- owner/2 handler/実BFF/ownership94件、Code SDK/relay/並行outbox/lock/Goal/関連owner131件、Core/契約/HTTP/AST/bundle207件、独立fixture1件の対象433件が成功。全体スイートは今回再実行していない。Backend/Web typecheck、強制Backendビルド7,205 KiB成功。
- Webなし隔離実Backend/SDKでCode Goal task/outbox実作成→panel/Goal/progress/ETag304→別Botのtask/request操作404→Goal pause/resume→request Stop/user-stopped保存→続行受付/abort→unlinkを確認。実プロセス再起動後のCode task/停止Goal/outbox保持と7 command IDの再実行409も確認（12.3秒）。
- Goalは既存fixture-only state command、Code/報告Botのモデルは到達不能localhostだけ。追加の有料/外部provider生成・tool実行・子agent起動はなく、既存固定Bot responderの3要求も増えていない。稼働ユーザーTask/Bot/設定/資格情報/SOUL/サービスへの操作なし。
- 原因: レビューで停止/部分link更新後のtyped 4xx例外を安全なrefusalとして返せる点を確認。503/unknown・秘密非公開・同ID拒否を追加検証した。初回HTTPテストは任意operationIdのundefinedをnull限定で比較したため503となり、未指定の契約に合わせて修正。ownershipの残存session-starter期待値は11→9。
- 並行差分7ファイルと既存routing timeout/selected-leaf永続化制約は保持し、今回解消したとは扱わない。Phase3全体は未完了で、Bot routine/sidebar/intercom/Room等25経路・41操作が残る。

## 第23区切り: Bot routine（3経路・6操作）

- `bots/[id]/routines` GET/POST、`routines/[routineId]` GET/PATCH/DELETE、`run` POSTをBackendへ移管。Nextは単一の中継returnのみ。UUIDのBot/routine IDを1回だけdecodeしてBot/routine保存先へのアクセス前に検証する。AST検証も複数の動的selectorをそれぞれencodeする構造へ拡張した。
- 既存routineの一覧/個別読取・CRUD・手動run・scheduler start/tickにowner guardを追加。cronの有効日/5分以上の間隔、名前100/プロンプト8,000コードポイント、enabled最大10件、失敗3回の自動disable、run claim/heartbeat、busy leaseの非消費、通知/完了busと待機完了を維持する。既知の設定検証は400、予期しないI/O/SDKエラーは秘匿する。
- createはownerが生成するID/保存Bot/失敗状態を使用し、runは保存済みpromptとBotのpermissionだけを使用する。PATCHは4つの設定フィールドと型を検証し、scalar/array/不正cron/過大文字列/実行状態の偽造を拒否する。routine/失敗後snapshot/receiptを純粋DTOで投影し、追加SDK/秘密フィールドや生の5xx例外を返さない。
- private `bot-routine-command.json`（0600・最大128件）はoperation IDとexecutionのみ記録。手動runを待機してもdisable/CRUDが詰まらない並行admissionを使用する。実行前unknown checkpoint、再起動後も同じIDは409、応答喪失/5xx/記録失敗はunknown、自動再送/Next実行fallbackなし。受付済みrunはクライアント切断で中止せず、明示Bot StopがSDKを中止する。schedulerのrun lockは別系統のままで、恒久的exactly-once/複数ファイルの原子性は保証しない。
- create/PATCH本文64 KiB（8,000文字を全てJSON escapeした場合を含む）、run/DELETEは4 KiB。認証/Origin/readiness、operation ACK一致、GETの無ledger、5xxでのscoped snapshotを維持する。

### 第23区切りの検証結果

- routine/実FS owner・手動handler・scheduler/cron・Next relay・runtime ownership: 108/108成功。
- pure contract/実HTTP transport/AST ownership: 117/117成功。Bot lifecycle/cron/scheduler/並行command・bundle/独立build: 57/57成功。独立実プロセスfixture1件を含め、今回の対象回帰283件成功。全体Web/Backendスイートは再実行していない。
- Backend/Web型チェックとBackend強制ビルド（7,220 KiB）成功。Webなしの隔離Backend実プロセスでroutine作成/list/個別GET/改名、保存promptによる実SDK text生成、hold中のdisable→Bot Stop→failure snapshot、別routineの削除、再起動後のdisable/失敗数/成功時刻/改名/削除と8つの重複受付拒否（held runはunknown、他はcomplete）を検証した。
- 新規routine用固定localhost responderは2回（正常1・hold/明示Stop1）。既存Bot responder3回は不変。tool call/resultを出さず、課金Provider/実通知/外部生成、ユーザー設定/SOUL/資格情報、稼働サービスを変更していない。
- 初回検証失敗の原因: ASTテストが動的IDを1つと仮定し、独立fixtureはBot configだけをseedして通常のBot作成で登録される1:1 Taskが欠落していた。ASTを複数IDへ拡張し、fixtureのTask登録を補って再実行成功。レビューでscalar PATCHの誤受理も修正し、関連検証を再実行した。

## 第24区切り: Bot sidebar・内線受信箱（2経路・3操作）

- `bots/sidebar` GET、`bots/[id]/intercom` GET/PATCHをBackendへ移管。Nextは単一relay returnのみ。Bot/Room/store/outbox/transcriptの読取、preview/件数/presence/未読/pending判断、mailbox既読の永続化をownerへ集約する。Bot IDはdecode一回・UUID-shaped検証後にBot保存先へアクセスする。
- sidebarは既存のoffline session previewのみ。4,000文字の先頭正規化・80コードポイント要約/emoji保護・invalid timestamp/null、8,000,000 bytes/24 filesのpreview budget、Bot全件でoutbox batch一回、owned/supervisedのworking Code件数を維持する。getTaskDetail/ensureLive/promptを呼ばず、投影済みDTOにprivate/no-cache ETagと304を生成する。条件付きGETでも不正DTOを304に隠さない。
- Inboxは全message/attachment metadata・pending ask・preview・peer presenceを深く投影し、authored text/config/Room history/Code/Goal/handoff correlationを保持。追加SDK/credential/privateフィールドとRoomのserver relay envelope tokenを除外する。既存GETのexpired ask cleanupもBackendだけが実行し、GETにcommand receiptは書かない。
- PATCHは既存action:readだけ。保存Botと既読timestampはownerが決め、callerのbotId/readAt/messages/pendingAsksを採用しない。common inbox読取・既読更新にowner guardを追加。lock/merge/atomic replace・inbox event通知を維持し、write/通知失敗後は503/unknownとcache破棄による実disk再読込にする。保存済み通知例外のtyped 4xxもrefusalにせず、秘密本文を返さない。
- 専用private `bot-overview-command.json`（0600・最大128件）のserial admissionでoperation ID/実行状態のみ記録する。4 KiB上限、認証/Origin/readiness、operation ACK一致、効果前unknown、同IDの再起動後409、受付済み切断で更新を中止しない規約を保持。全mailbox/通知の原子性や無期限exactly-onceの保証は追加しない。

### 第24区切りの検証結果

- 新owner/既存sidebar handler/実Next relay: 56/56成功。既存Bot intercom/tool・offline preview/budget・runtime ownership: 75/75成功。
- pure contract/実HTTP transport/AST ownership: 121/121成功。Bot intercom policy/serial command/lifecycle/Room normalize・bundle/build independence: 44/44成功。独立fixture1件を含め、今回の対象297件成功。全体スイートは再実行していない。
- Backend/Web型チェック、Backend強制ビルド（7,241 KiB）成功。Webなし隔離Backend実プロセスでcold Botのoffline sidebar/Room preview/ETag304、mailbox/pending/attachment読取、invalid action拒否、偽造timestamp/別Botの無視と既読保存、再起動後の未読0・message/pending/queued保持・2 IDの再実行409・offline preview保持を確認（13.5秒）。
- 追加のSDK attach/provider要求なし。既存固定localhost responderのBot3回/routine2回は不変。ユーザーSOUL/設定/資格情報/稼働サービス、課金Provider/実通知は操作していない。対象18ファイル以外の並行差分7ファイルを保持する。
- 原因: 既存mark-readが保存前にcache markerを変更し、I/O失敗時も後続GETが既読成功のように見え得た。保存失敗時はcacheを破棄してdiskを再読込し、保存後通知例外も503/unknownにする。実lock拒否とtyped listener例外で保存未完了/保存済みの両方を検証した。初回owner件数テストはBot会話をCode一覧へ数えており、実Code taskを登録するfixtureへ修正して再検証成功。

## 第25区切り: Room lifecycle（2経路・5操作）

- `bots/rooms` GET/POST、`bots/rooms/[id]` GET/PATCH/DELETEをBackendへ移管。Nextは単一relay returnのみ。Room一覧/個別読取、入力検証・既知メンバー判断、作成/保存、設定変更・会話リセット・メンバー離脱・削除のteardownをownerへ集約する。
- `room-lifecycle-api.ts`のread/create入口、既存admin入口・common create/patch/deleteにowner guardを追加。Room IDはdecode一回・UUID-shaped検証後に保存先へアクセスする。未移管のRoom送信/Code停止/巻戻し/イベント/添付読取を壊さないため、全common読取/全writerの一律禁止は行わない。
- 作成時の既存default名・trim・100コードポイント上限・既知メンバーの順序/dedupe/未知ID filter、PATCHの未知メンバー拒否、relay/Code standing approvalのtrusted認証を維持。callerのRoom ID/history/作成時privilegeを採用しない。Ingressは共通Web認証/Origin/readiness、ownerはtrusted contextでprivileged PATCHを検証する。
- resetはturn停止→handoff取消→Code停止→member session reset→Room transcript clear、離脱はdetach後にmembers更新、削除はturn/handoff/Code停止→該当Room bot tasks destroy→Room JSON/添付data削除。別Room・Bot 1:1・Code workspaceは保持。resetの添付は既存仕様どおり保持し、Room削除時だけdataディレクトリを削除する。
- pure DTOはsidebarの深いRoom projectorを共用し、derived preview欄を付けずに全authored message/attachment metadata・conversation/Code/Goal/handoff correlationを投影する。server relay envelope token/追加SDK/private欄は返さず、壊れたsuccessは503。
- serial `room-lifecycle-command.json`（0600・最大128件）はID/executionのみ。効果前unknown、ACK一致、同IDの再起動後409、応答喪失/5xx/receipt失敗unknown、受付済み切断でもteardown続行、Next fallback/自動再送なし。POST/PATCH 64 KiB、DELETE 4 KiB、GETはledgerなし。複数ファイルの原子性/無期限exactly-onceは保証しない。
- 原因: 旧admin catchは停止/離脱/保存後のtyped 4xxを未実行のrefusalのように返せた。またresetと未知membersを同時指定するとmember検証より先にsessionを停止し得た。全requested membersを効果前に検証し、効果開始後の失敗は503/unknownへ統一。保存済みevent例外も実disk状態を保持し、rollback成功を偽装しない。
- Room送信/Code停止/巻戻し3経路・3操作は次の区切りに残す。Phase3全体の完了とは扱わない。

### 第25区切りの検証結果

- owner/admin/common Room CRUD・実Next relay・runtime ownership: 83/83成功。未移管Roomのprompt/revert/Code/events、Room runtime/conversation/opener/events: 209/209成功。
- pure contract/実HTTP transport/AST ownership: 123/123成功。Room store/normalize・serial command・build: 34/34成功。Webなし隔離実Backend/SDKと実再起動fixture1件を含め、対象回帰450件成功。全体スイートは再実行していない。
- Backend/Web型チェックとBackend強制ビルド（7,249 KiB）成功。隔離fixtureで実Room list/create/read/privileged PATCH、未知members+resetの効果前400、cold Room member session reset、detach、Room task/JSON/添付data削除、別Room/1:1/outbox/workspace保持、再起動後の削除と7 IDのcomplete replay409を検証（20.2秒、並行検証時）。
- 追加Provider要求なし。cold Room sessionのSDK reset/destroyのみ追加し、既存固定localhost responderのBot3回/routine2回は不変。課金Provider/tool実行/実通知・ユーザーSOUL/設定/資格情報/稼働サービスへの操作なし。並行差分7ファイルを保持する。
- 検証fixture修正: collection/privileged PATCHの旧テストはローカルNext handlerを前提としていたためBackend handler検証へ変更し、BFFは別の5操作テストで検証。深い添付DTOのfixtureを実RoomFileのsizeへ修正。Web型チェックはprojectを明示して再実行した。

## 第26区切り: Room会話コマンド（3経路・3操作）

- `bots/rooms/[id]/prompt`・`code`・`revert` POSTをBackendへ移管。NextはencodeしたRoom IDを単一relayへ渡すだけ。送信のRoom/メンバー選択・relay capability消費・attachment検証/保存・opener/steer/fanout/rotate/Stop、Code outbox選択/停止、巻戻し/attention取消/attachment復元は全てownerが実行する。
- common prompt/revert/composer/Room Code entry、Room relay消費・添付保存・transcript rewindにowner guardを追加。未移管SSE/asset readに必要なcommon読取は一律禁止しない。32,000コードポイント・添付最大8件・画像個別8 MiB/合計12 MiB・UTF-8ファイル合計64 KiB、keyword→LLM opener、同Room steering、Room間の独立性・最大6参加者/8turnを維持する。
- relayは保存済み単一使用envelopeだけがsource/targets/depth/turnを確立し、callerのBot/task/turn authorityを採用しない。CodeはこのRoomのactive outboxだけを使用。requestId明示時は64小文字hexを検証し、未指定時だけ既存pending selectionを許す。明示不正/foreign IDから別要求へのfallbackなし。user-stopped→cold Goalを含むabort→finally completionの順序と完了済み成果保持を維持する。
- rewindは対象user messageを効果前に検証し、turn停止→共有履歴切詰め→member attention取消→削除した全user requestのCode取消→owner内composer添付復元。Botの各SDK会話は巻戻さない。失われたRoomへ旧snapshotをsuccessとして返さない。既存のmissing添付skipと添付ファイル保持は維持する。
- pure contractはRoom authored history/metadata・routing/steering/Stop/relay correlations、composer data URI/name、選択Code task/stateを深く投影。server envelope token・SDK/private fieldsを除外し、不正successは503。prompt18 MiB、Code/revert4 KiB、Room IDはdecode一回・UUID-shaped検証、message IDは256文字/制御文字拒否。
- concurrent `room-conversation-command.json`（0600・最大128件）はID/executionだけを保存。opener/準備を待つpromptの後ろにCode Stop/別コマンドを並べない。効果前unknown、ACK一致・再起動後同ID409、自動再送/Next fallbackなし。受付済みdisconnectでopener/生成/巻戻し/停止を中止しない。明示Room Stopはopener/providerを停止する。completeは受付handler終了であり、background生成/通知/配達の完了や複数ファイルの原子性ではない。
- 原因: 旧prompt/revert/Codeはappend/relay消費/rewind/stop/保存後のtyped 4xxを未実行refusalとして返せた。効果開始後の例外を503/unknownにし、保存済み履歴を取り消したと偽装しない。実disk event例外・post-rewind取消例外・abort後finallyで検証した。

### 第26区切りの検証結果

- owner/Backend handler/実Next relay/runtime ownership:128/128成功。Room runtime/CRUD/conversation/opener/events:142/142成功。pure contract/実HTTP transport/AST ownership:127/127成功。Room store/normalize・concurrent admission・build:37/37成功。独立fixture1件を含め、対象回帰435件成功。全体スイートは再実行していない。
- Backend/Web型チェック、強制Backendビルド（7,260 KiB）成功。Webなし隔離Backend/実SDKでRoomファイル/PNG添付送信→固定日本語応答、hold→明示Room Stop/provider socket閉鎖、Room所有Codeのstate-only Goal開始/停止、1:1/別Room outbox保持、composer text/添付復元、再送/共有履歴追記、実再起動後の復元と6 IDのcomplete replay409を確認（14.1秒）。
- 新規Room localhost responder3回（正常・hold/明示Stop・追記）。既存Bot3回/routine2回は不変。providerは固定textだけを返し、tool call/result・課金/外部生成/実通知・ユーザーSOUL/設定/資格情報/稼働サービスへの操作なし。並行差分7ファイルは保持する。
- fixture修正: 新mutationにoperation IDが欠落し、追加Bot UUIDが既存「未知メンバー」fixtureと衝突していた。隔離Taskをseedし、Room Code contextを実型のconversation.requestId/participantIds/turn/maxTurnsへ修正して再実行成功。旧disconnect取消テストは新受付規約に合わせ、disconnectでは継続・明示Stopで取消を別々に検証。UTF-8拒否fixtureは有効NULでなく不正UTF-8 byteへ修正した。診断用fixture instrumentationは除去済み。

## 第27区切り: TypeSafe cookie・基準残高（2経路・6操作）

- `typesafe-cookie`・`typesafe-baseline`のGET/POST/DELETEをBackendへ移管。Nextの6操作は単一relayのみで、cookie読取/検証/保存/削除・基準残高の判断/永続化・usage/provider cache更新を実行しない。owner service/read/handlerとcommon cookie保存/削除・baseline writerを効果前にguardする。
- 元の貼付けcookie入力形式・session_id/organization_id必須・TypeSafeドメイン/有効期限検証を維持し、追加auth/CSRF cookieは保存、他ドメインは除去。保存済み標準ファイルだけをGETのconfiguredに使用する。標準APPDATA/CodexBarパスはowner環境から決定し、callerのpath/accountIdを採用しない。cookie本文・組織ID・privateパスは応答/ledgerへ返さない。
- cookie本文100万UTF-16文字の制限、有限かつ0より大きく100万USD以下のbaseline POST、DELETE後false/null、GETの既存欠落/破損時false/nullを維持する。legacy手動baselineが100万超でもGETは従来通り値を返す。cookie POST8 MiBは最大100万文字のJSON escape展開を収容し、その他4 KiB。wireはconfigured/baselineUsd/ok/ID-only receiptだけを投影し、NaN/InfinityをJSONのnullへ隠す前にowner GETで検証する。
- serial `typesafe-settings-command.json`（0600・最大128件）は効果前unknown、処理終了後complete、同IDは実再起動後も409。GETはledgerを作らない。private cookie/基準残高/秘密hash/ファイルパスを記録しない。ACK不一致/欠落は503、受付済みdisconnectでも書込を取り消さず、自動再送/Next fallbackなし。bounded ledgerの期間を超える無制限exactly-onceやcache/ファイル/ledgerの原子性は約束しない。
- 原因: 旧common DELETEはunlinkの全例外を「既に不存在」と握り潰し、削除できなくてもfalse/nullのsuccessを返せた。ENOENTだけを不存在と扱い、それ以外を503/unknownへ変更。保存後のcache例外もtyped 4xxを未実行refusalにせず503/unknownにし、diskに残った保存内容をGETで確認できる。実directory障害とpost-save cache例外で検証した。
- cookie保存は共通の0600一時ファイル置換を使用し、初期書込からprivate権限を指定する。Windowsでは共通writerがrename不可時にcopyを使うため、常に原子的とは主張しない。write途中/権限/cache/receipt障害は結果不明として保存を偽装rollbackしない。usage cache期限切れ化と`default:typesafe`のprovider cache消去はownerで維持する。

### 第27区切りの検証結果

- owner/旧Backend handler/実Next BFF・Typesafe provider・account/usage/Chromium/runtime ownership回帰110件、provider cache4件、pure contract/実HTTP/AST130件、serial admission/configuration/build18件、Webなし独立Backend1件、計263件成功。全体スイートは再実行していない。
- Backend/Web型チェック、強制Backendビルド（7,269 KiB）成功。隔離APPDATA/Backendでcookie保存→許可domain/追加CSRF保持/他domain除外→秘密非返却GET→削除、baseline保存/GET/削除/拒否/再保存、actual owner再起動→baseline59.5とcookie削除状態復元、7 IDのcomplete replay409を確認（15.2秒）。
- TypeSafe判定/Console billing/課金・実資格情報/実baseline・ユーザーSOUL/サービス再起動への操作なし。固定localhost Bot3回/routine2回/Room3回は不変。fixture秘密値だけを隔離標準cookieファイルへ保存し、再起動前に削除した。並行差分7ファイルを保持する。
- fixture修正: 旧Next handlerテストをBackend入口へ切替え（最初の相対import深度誤りをaliasで訂正）、HTTP boundテストにoperation IDを追加。GET異常数値fixtureをJSON化前に検証するよう修正。HTTP大body拒否の単発ECONNRESETは再実行で130/130成功。Webテストhelperのopaque DTO型とUUID型を明示し、型チェックも再実行成功。

## 第28区切り: MCP定義・認証（3経路・6操作）

- `mcp` GET/POST、`mcp/[name]` PATCH、`mcp/[name]/auth` GET/POST/DELETEを単一Next relayへ変更。開発時のローカル設定/SDK/bridge fallbackも撤去し、Nextは本文を業務解釈しない。一覧・preset・ON/OFF・bearer/headers・OAuth開始/完了・削除はBackend ownerが判断する。
- `backend/src/mcp-json-business.mjs` は既存private MCP transportと同じNode native/legacy action compositionを使用する。native credential branchingをbundled handlerへ複製しない。common admin/read/write/bridgeと低レベルwriterは開発Nextも効果前に拒否する。固定owner環境の設定/credential storeを使用し、callerのcommand/configPath/privateオプションは拒否する。
- nameは一度だけdecodeし、空/制御文字/区切り/`..`/256文字超を拒否。query、未知fields、非boolean enabled、invalid auth/header/OAuth入力、invalid UTF-8を効果前に拒否する。auth POST2 MiB、preset POST64 KiB、その他4 KiB。認証・Origin/CSRF・readiness・内部protocol・世代境界を維持し、TLS proxyの同authorityも従来通り許可する。
- 公開契約は静的一覧/認証metadata/ON-OFF/preset/reload/OAuth URL/ID receiptだけを深く投影する。credential値、private command/env、config path、URLのuserinfo/secret query、raw reload errorsを返さない。OAuth state/PKCE challengeは保持し、verifier-bearing URLは拒否する。name/enabled不一致のowner成功は503/unknown。
- serial `mcp-business-command.json`（0600・最大128 ID）は効果前unknown、確定終了complete。同IDは再起動後も409。秘密本文/hash/path/server名をledgerへ記録しない。GETはledgerなし。ACK欠落/不一致は503。受付後disconnectは処理継続、自動再送・Next fallback・偽装rollbackなし。Nodeとbundleはsymbol-backed AsyncLocalStorageの効果観測を共有し、書込/credential/flow/reload後のtyped 4xxも503/unknownにする。無制限exactly-onceやconfig/credential/reload/receiptの原子性は約束しない。
- native bearer/header保存・削除とOS/既存credential ownershipを維持する。native OAuth開始/完了は既存の未実装409 refusalを維持（complete receipt）。legacy bridge不在は従来の503 unavailableを結果不明として返し、成功やrollbackを偽装しない。ON/OFFは永続化後にownerだけが非同期reloadする既存挙動を維持する。
- レビュー修正: nativeへの空DELETEをowner認証metadataから解決し、従来のdefault removal規約を保持した。原因: common readerの非strict fallbackは壊れた設定を空と見なし、writerが別設定を上書きでき、parser例外がログへ漏れ得た。writer/認証metadata用readerをstrict defaultにし、破損時は効果前に拒否・元bytes保持・秘密ログなしを検証した。

### 第28区切りの検証結果

- common MCP/admin/owner/実Next BFF/private client/runtime ownership回帰199件、Node owner/pure contract/実HTTP/AST/native実行154件、serial admission/build/runtime bundle14件、Webなし独立Backend1件、計368件成功。全体スイートは再実行していない。
- Backend/Web型チェック、強制Backendビルド（7,271 KiB）成功。Webなし隔離Backendでlocalhost URL preset保存/ON-OFF/一覧/auth metadata/legacy不可用応答、実再起動後の設定復元と6 IDのcomplete/unknown replay409を確認（15.2秒）。別の隔離native Backendで新JSON入口からbearer/header保存/削除、手動header保持、空DELETEのowner解決、native OAuth開始/完了409、重複拒否、秘密非返却/非ledgerを確認した。
- OAuth SDK bridgeはmockで検証し、実OAuthフロー・実資格情報・外部MCP接続/command・課金生成・ユーザーSOUL/稼働サービスへの操作なし。実保存は隔離fixture credentialだけ。既存localhost Bot3回/routine2回/Room3回は不変。並行差分7ファイルを保持する。
- fixture修正: ownership ASTのbundled-handler固定前提をNode compositionにも対応させた。旧Next local/production分岐テストは実relay検証へ置換し、既存common/admin回帰は維持。reload mockの対象を実import先へ訂正。legacy bridge不在とnative OAuth未実装を区別し、Web helperのOAuth request型/異種callback型を修正して再検証した。

## 第29区切り: メモリ検索・システム監視・既読状態（3経路・4操作）

- `memory-search` POST、`sysmon/usage` GET、`unread` GET/PUTをBackendへ移管。Nextは単一relayだけになり、SQLite検索・OS/子プロセスのsampling・cache・設定読取/既読保存を行わない。common検索/collector/cache getter/既読reader/writerとLinux実FS/command adapterは開発Nextも効果前に拒否する。
- memory検索はowner環境のmemory設定から固定DBを決定し、callerのdatabasePath/path/target/projectを採用しない。200文字・12 term・20結果、FTS/trigramとliteral LIKE fallback、readonly/native SQLite handleの4件/60秒cache・更新時reopen、参照日時非更新を維持する。純DTOはscope/category/著者content/日時だけを保持し、DB path・追加private列を落とす。検索POSTはread-onlyなのでoperation ID/ledger不要。同期SQLite読取は開始後に個別HTTP取消で中断しない。
- CPU/RAM/GPU/温度sampling、250ms CPU sample、usage single-flight/TTL、温度cache、GPU stale fallback/empty backoffはBackendだけが所有する。クライアントも使う純計算/型を`shared/sysmon.ts`へ分離し、OS依存collectorと混ぜない。probe例外は従来の200/available:falseを維持し、raw command/exceptionを固定理由へ置換。非有限/不正な成功metricsはJSON nullへ変換する前に503へ拒否する。
- 既読はbot/room/task、1〜256文字ID、有限の正のreadAtを維持し、既存settings RMW lock内でmax(previous,incoming)を永続化する。無関係の設定を保持する。serial `unread-command.json`は0600・最大128 ID、効果前unknown/終了complete、同IDは実再起動後も409。marker/id/path/時刻/秘密hashはledgerへ記録しない。GETはledgerなし。受付後disconnectは処理継続、ACK欠落/不一致とpost-save typed 4xxは503/unknown、自動再送/Next fallback/偽装rollbackなし。無制限exactly-onceやsettings/cache/receiptの原子性は約束しない。
- 認証・Origin・readiness・protocol・世代確認を維持し、対象の本文は4 KiB、公開応答は既存32 MiB上限。SQL/FS/command/破損setting例外のprivate本文は応答/ログへ返さない。旧GETの破損既読settingsの空fallbackは維持するが、PUTは既存RMW lock内でfixed settingsのJSON/versionを検証し、破損時は更新せず原本bytesを保持する。
- 原因: 旧既読mapの通常objectは`constructor`/`__proto__`を継承値/特殊setterとして扱い、NaNや未保存の成功になり得た。null-prototype mapで既存の任意ID規約を保持し、monotonic保存/再起動復元を検証。共通settings readerの寛容fallbackがwriterへ伝播して別設定を消し得る点も、lock内検証で拒否した。
- SQLite native bindingはbundleへ埋め込まず`better-sqlite3`をexternalにし、Backend自身のnode_modulesから解決する。Backendに`@types/better-sqlite3`を追加し、Web型/packageへの依存なしでコンパイルする。実DB照会を含むWebなしfixtureで検証した。

### 第29区切りの検証結果

- 検索/監視/既読/common cache/owner/実Next BFF/関連設定/runtime ownership回帰116件、pure DTO/実HTTP/AST/serial admission/Backend build/native binding回帰155件、Webなし独立Backend1件、計272件成功。全体スイートは再実行していない。
- Backend/Web型チェック、強制Backendビルド（7,326 KiB）成功。Webなし隔離Backendで実native SQLite FTS検索/著者日本語content/DB bytes不変、CPU/RAMの有限値・usage cache再利用、特殊名IDの既読保存/古いreadAtの拒否的max、無関係settings保持、実owner再起動後の検索/既読復元と4 IDのcomplete replay409を確認（15.9秒）。
- GPU/thermal probeはfixtureの存在しないbinary名とthermal無効設定で隔離し、実GPU/PowerShell/WMI/kernel probeやレジストリ/driver変更は実行していない。実CPU/RAM読取は読み取りのみ。Linux sysfs・温度/GPU parsing・cacheはfake source/既存unitで検証。外部生成/課金・実資格情報・ユーザーSOUL/サービスへの操作なし。既存localhost Bot3回/routine2回/Room3回は不変。並行差分7ファイルを保持する。

## 第30区切り: browse一覧・アイコン（2経路・3操作）とHost native選択

- `browse/dirs` GET、`browse/icon` GET/POSTをBackendへ移管。対象Nextは単一relay returnのみ。home/OneDrive/登録project/許可されたquick access・drive rootsの決定、canonical path認可、directory/候補file列挙、画像読取・EXE metadata抽出、OS discovery/cacheをBackendが所有する。開発Nextもhandler/dispatcher/path reader/drive cache/画像reader/XDG readerの効果前に拒否する。
- dirsは従来のhome/quick access/drive認可、30秒single-flight/cache/stale fallback、`.git`を残すhidden-filter、inside symlink/junction表示、日本語ソートを維持。iconはhome/OneDrive/登録projectの範囲を維持し、候補をdirectory→画像/Windows EXE順に返す。callerのroots/env/commandは採用しない。lexical範囲外のUNC等はrequested targetのrealpathより前に拒否する。認可後のIOにはresolverのcanonical結果を使用し、outside-root symlinkを表示/読取対象から除く。UI DTOには認可された元の選択path/parent/名前/候補を保持する。ローカル同時変更に対するfilesystem全体の原子性は保証しない。
- Backendの3操作はread-only。icon POSTにもledger/operation IDを作らず、Origin拒否は維持する。認証required modeと従来loopback optional-auth mode、内部token/protocol/readiness/世代/本文opaque輸送を維持する。本文256 KiB、公開応答32 MiB上限。追加owner情報/command/env/tokenを深く除き、不正成功は503。読取失敗の200/空entriesは維持するが、raw errno/command/例外は固定理由へ置換する。画像は2 MiB、EXEのbase64は3,000,000文字上限を保持し、選択EXE自体は起動しない。
- Phase0でHostに分類された`browse/dirs` POSTもNextから分離。Host private `POST /browse/select-folder`と固定UTF-16LE encoded PowerShell/UTF-8 stdoutのFolderBrowserDialogへ移管し、Windows-only/120秒/選択directory確認/cancel/Disposeを維持する。Nextは認証/Origin/4 KiB admissionとopaque Host relayだけ。Hostはloopback Host header、browser Originなし、専用private header、method/本文boundを確認する。callerのpath/command/envでdialogを構成しない。Host未対応404/501は501/not-started、切断/不正応答/例外は503/unknown。受理後の切断でもdialog処理は継続し、同時に別窓を開かず409。自動再送/Next fallbackなし。Host restartを跨ぐdedupe/永続receipt/exactly-onceは保証せず、GUIでの新規folder操作もrollbackしない。稼働Hostは再起動していないため、旧Hostは未対応として明示拒否する。
- 原因: 旧認可はboolean確認後にraw pathを再使用し、linkの再解決を分離していなかった。canonical結果で列挙/読取/EXE選択し、inside linkのstatにも認可結果を使用する。旧画像readerはstat後のfile成長をreadFileSyncで無制限読取できたため、単一handleと2 MiB+1 byte bounded read/closeへ修正した。寛容なoptional-authと厳密なrequired-authを混同しないようowner入口も修正・再検証した。

### 第30区切りの検証結果

- common/path/cache/画像/XDG/owner/Backend handler/実Next BFF/relay/runtime ownership115件、純契約/実Backend HTTP/AST/Host private HTTP/dialog adapter/Host回帰/build/runtime bundle215件、Webなし独立Backend1件、計331件成功。全体スイートは再実行していない。
- Backend/Web型チェック、強制Backendビルド7,351 KiB成功。Webの途中検証は並行作業の`extensions/leafcode-todowrite/enforcement.ts:173`のTS2367 1件で失敗したが、担当セッションの別commit `b9feeee3`後に実ツリーで再実行し成功した。他者実装をこちらで変更していない。途中のHEAD reader-overlayはinterface差異/時間上限で失敗しており、成功証拠には加算しない。
- Webなし実Backendで隔離project登録、directory/`.git`/inside junction/hidden-filter/候補一覧、実ICO bytesとdata URL、relative path拒否、Host専用POSTの405、実プロセス再起動後の一覧/画像復元・bytes不変を確認（16.2秒）。Hostは実loopback private HTTPで認証前のadmission、opaque input非採用、cancel/未対応/不正success、raw failure除去、受理済disconnect継続/同時窓拒否を確認。native UI/EXE抽出はmock adapter、discoveryは存在しないfixture binaryで隔離し、実dialog/選択EXE/ユーザーfolderへの操作は行わない。
- fixture修正: 旧業務テストをBackend handlerへ向け、Nextは実relay/ASTに置換。home内のtmpdirをoutsideと誤認するfixture、export内部参照へ効かないspy、Host listen helperのvoid返却とport0/Host guard前提、URL由来queryを未定義input.queryで読むmockを修正。Node built-in ESM exportはpartial mockで検証し、画像成長後もbyte bound/closeを確認。初期7並行差分と追加ToDo並行差分5ファイルを対象commitから除外する。

## 第31区切り: TTS音声一覧・HTTP合成（2経路・2操作）

- `settings/tts/voices` GET・`tts/synthesize` POSTは単一Backend relay。設定reader、enabled/URL認可、Bot存在/voice優先、一覧取得、HTTP合成はBackend。callerのURL/voice/configは採用しない。型/catalog/ラベル・Aivis talk-style射影はclient-safeな `shared/tts-backends.ts` に移し、Web互換exportを維持した。設定reader/writer・合成・metadata reader・dispatchはdevelopment NextをIO前に拒否する。
- 既存2000文字、OpenAI互換speech/v1-tts/generic body、VOICEVOX audio_query→synthesis、2500ms一覧/各段60秒合成timeout、redirect拒否、音声64MiBを維持。本文16KiBはJSON escapeを含む。公開成功は従来通りraw audio/MIME。内部のみbase64 JSONとし、canonical padding・MIME・decoded byte上限を検証する。合成のwireだけ90MiB、他の業務応答32MiBは不変。NextはACK一致後にdecodeするだけ。ストリーミングではなくbase64のメモリ/CPUオーバーヘッドがある。
- 合成POSTだけconcurrent/0600/max128/ID-onlyの `tts-synthesis-command.json` を使用。文章・音声・URL・Bot IDは保存しない。受付済disconnectは継続、同ID/restart replayは409。provider開始後typed 4xxは503/unknown、失敗/記録不確実性をcomplete/rollbackに偽装しない。unknownはevictしない。一覧GETはledger/ACKなし。
- 原因: レビューでengine metadata/queryの未上限readを確認。両方を8MiB・実ストリーム計数・fatal UTF-8に変更し、超過時cancel、query超過後のsynthesis拒否を検証した。音声64MiBとは別の上限。private metadata/raw engine failureは公開しない。
- 対象264件成功（Web98、Node/Core/AST/build165、独立fixture1）。両typecheck成功、強制Backend build7368KiB。途中の型/alias/末尾空行エラーは修正・再検証した。全体suiteは未実行。
- Webのソース/パッケージがない実Backendでlocal responderの音声bytes/MIME、日本語text、global/Bot voice、caller設定無視、engine failure/unknown、設定永続化、実再起動後4IDの409/no再生成を確認（15.6秒）。HTTP ingressでもdisconnect継続を確認。Aivis一覧はmock、独立fixtureのcustom URL一覧は従来通り空/no probe。実TTSモデル/SAPI/音声再生/課金・ユーザー設定/サービス操作は未実行。

累計115/118経路・179/182操作。残りは `backend/tasks`・`link-preview`・`translation/reasoning` の3経路・3操作。Phase3全体は未完了。
