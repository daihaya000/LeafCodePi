# Phase3: JSON業務APIの移管

## 進捗・範囲

Phase3全体は未完了。Phase0のBackend/Phase3/JSON分類は118経路・182操作。Git・Diff・コミット文生成13経路・14操作、定義管理14経路・25操作、Provider/モデル設定7経路・8操作、Provider認証JSON4経路・5操作、アカウント管理/資格情報9経路・19操作、利用量/クレジット3経路・5操作、Peer認証共有5経路・9操作、Workspaceファイル/次タスク提案3経路・3操作、Project lifecycle1経路・4操作、Task collection1経路・3操作、個別Task lifecycle2経路・4操作の合計62経路・99操作の境界を移管した。認証に付随するログインSSE 1経路・1操作も同じownerへ移管した（Phase3 JSONの集計には加算しない）。残る56経路・83操作には既存Backend中継も含まれ、受入条件の確認・残存業務処理の移管が必要。

以下は第1区切り（Git・Diff・コミット文生成）の記録。第2区切りの定義管理、第3区切りのProvider/モデル設定、第4区切りのProvider認証、第5区切りのアカウント管理/資格情報、第6区切りの利用量/クレジット、第7区切りのPeer認証共有、第8区切りのWorkspaceファイル/次タスク提案、第9区切りのProject lifecycle、第10区切りのTask collection、第11区切りの個別Task lifecycleは末尾に記載する。

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
