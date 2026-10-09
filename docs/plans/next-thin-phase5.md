# Phase5: 旧経路撤去・最終検証

## 受入条件

Nextは画面・ブラウザ認証・入口制限・HTTP中継だけを担当する。旧実行経路・不要SDK依存を撤去し、禁止importの自動検査と、Web停止/再起動中のBackend実行継続を確認する。

## 第1区切り: Next起動経路の撤去

- `web/src/instrumentation.ts` はNext role設定とHTTP Content-Type互換patchのみ。runtime初期化、owner lock取得、再起動復旧、lease/Room reconcile、Bot relay、routine/reset scheduler、SDK/model/store warmup、label backfillを開始しない。
- 旧 `web/src/lib/pi/runtime-startup.ts` と、そのローカル起動を期待するテストを撤去。Backend自身の `startup.mjs` / `RuntimeStartup` は残し、初期化・復旧・scheduler順序の既存試験を維持する。
- runtime ownership guardは明示的なNext roleを最優先とし、development/production/test、継承したBackend markerのいずれでもNextに実行を許可しない。独立Backendと、Next roleを持たない既存SDK/test consumerの挙動は維持する。
- `scripts/check-next-startup-boundary.mjs` はinstrumentationのvalue import/re-export/dynamic import/requireを推移的に検査。Backend/SDK/ファイル・子プロセス依存、非literal loader、相対escape/symlinkによるowner参照、旧startup fileの復活を拒否する。許可する外部importはHTTP patchの `node:http` のみ。Web buildではmirrorの依存を準備した後、そのTypeScriptを使って既存`.next`の退避・変更より前に検査する。checkoutのWeb依存が未導入でも、検査器のmodule import自体は失敗しない。
- この検査は**起動閉包だけ**のゲート。全画面/APIの禁止import検査ではなく、Phase5全体の完了を意味しない。

## 第1区切りの検証結果

- HEAD `564258c5` の隔離展開に、この区切りの所有差分だけを重ねて検証。並行harness/GoalLoop/provider-overload差分は含めない。
- Webの起動/所有権/HTTP patch/relay境界: 7 files・89 tests成功。Backend起動列・Host build/mirror・起動閉包検査・native register子プロセス: 106 tests成功。API ownership検査は作業ツリーで9/9成功、165 routes/265 operationsに欠落・重複・未所有なし。
- Backend強制build、Backend runtime typecheck、Web全source-only typecheck成功。Webを持たない実Backendのbuild/起動/実SDK・業務API/再起動fixtureも1/1成功（17.1秒）。実サービス/実資格情報/課金生成を使わない。
- native register試験は3個の独立子プロセス（development/production/test）でcold並行5回登録、実HTTP patchのidempotency、runtime拒否、親が保持するruntime owner recordのbytes不変、runtime singleton未生成を確認した。本物のNext framework全体や実行中SDKを跨ぐWeb再起動の証拠ではない。
- 隔離archiveの初回mixed native runは112/113成功、ownership Markdown比較だけCRLF差で失敗。作業ツリーの9/9成功と、隔離文書の改行正規化比較で165 routes/265 operations一致を確認済み。無関係なownership checker自体は変更しない。

## 第2区切り: 共通認証・Backend HTTP transportの分離

- Browser認証のNode版/Edge-safe版、Origin guard、private Backend HTTP clientを `shared/` の純認証・transport実装へ移動。WebとBackendの旧import先は同じ共有実装へのre-exportとして残す。Node版のSHA256＋`timingSafeEqual`、required時のfail-closed、Cookie/Bearer契約、protocol/generation確認、deadline、owner障害時の非fallback・非再送は変更しない。
- MCP DTO型は `shared/mcp-types.ts` へ分離。HTTP clientにBackend業務moduleの型参照も残さない。generation markerの読取はHost管理のtransport metadataとして保持し、業務状態の読書き権限と区別する。
- `scripts/check-next-transport-boundary.mjs` は8入口（Proxy、Browser sign-in、configuration/JSON/SSE/file relays、runtime-event transport）の値依存閉包を検査。sharedの `.mjs` を `.d.mts` の存在に関係なく実装まで追い、Backend/SDK/store/native process、非literal loader、relative escape/symlink owner参照、未解決依存を拒否。generation marker以外のFS依存を拒否し、marker helperでも `readFileSync` 以外のFS importを認めない。
- Web buildはmirrorのcompiler準備後、既存`.next`退避前にtransport gateも実行。Vitestの共有契約aliasも新ownerへ更新し、テストだけBackend implementationへ戻る誤解決を避ける。
- **このゲートは移管済み共通入口だけ**。全165 routes・画面の最終gateではない。棚卸しで `/api/health` のharness呼出し、`/api/build-info` のGit更新、Host/llama経路のローカル設定読取・health cache更新、旧relay/runtime ownership参照が残ることを確認した。これらのowner移管、Host folder relayのtransport分離、画面helper/SDK依存除去は次区切りで行う。
- standalone bundle子プロセス試験はNext test aliasを使わず、Web compatibility importを直接bundle。外部依存がNode builtinsのcrypto/fsのみで、Backend/SDK/installed packagesがなくても認証・Origin・protocol・generation更新・非fallbackを確認する。これは実Next/SDK再起動継続受入の代用ではない。

## 第2区切りの検証結果

- HEAD `02957bab` の隔離展開に自分の21 pathsだけを重ねて検証。他者harness/GoalLoop/provider-overload差分を含めない。認証・Origin・HTTP clientの4実装は、import先の変更とcomment除去を除き、移動前とTypeScript runtime emitが同一。MCP DTO型本文も同一。
- Web境界回帰: 211 files・1543 tests成功。起動/transport gate・SDKなしstandalone bundle/typecheck・Host build mirror: 91 tests成功。API ownership: 作業ツリーで9/9成功、165 routes/265 operations一致。共通入口の禁止import gateは8 roots/66 modulesで成功。
- Backend強制build、Backend runtime型検査、Web全source-only型検査成功。shared認証/client単体のstrict型検査もBackend/SDK sourceなしで成功（既存projectと同じallowJs）。Webなしの実Backend build/実SDK・業務API/独立再起動fixtureは1/1成功（17.3秒）。
- 実Next production fixtureは15 unchanged API routes/80 source modulesをbuildし、約125秒SSE、256MiB cold branch、512MiB files、Range/HEAD、cancel、再接続・再起動を1/1成功。最大増分bytesはBackend RSS/heap/external `87,322,624 / 36,614,400 / 68,434,278`、Next `96,055,296 / 18,737,256 / 66,890,648`。steady heap増分はBackend `868,440`、Next `83,000`。従来のRSS128MiB/heap48MiB/external96MiB/steady heap8MiB以内、forced GCなし。活動reader/subscription/FD残留なし（bounded cold index cacheは仕様内）。
- このproductionストリームfixtureは `sdkLoaded:false`。SDK生成中のWeb停止/再起動継続・非再実行の最終受入ではない。全Web suite、全画面構成、実provider/engine、無期限稼働の保証も行わない。Phase5全体は未完了。

## 第3区切り: HostのGit情報・更新ownerと共通Host中継

- Phase0の最終ownerどおり、`/api/build-info` のGit参照・fast-forward更新をHost control serverのprivate `/build-info` へ移管。Nextは認証・Origin・byte/deadline制限・receipt検証・HTTP中継のみ。Backend停止時もHostの情報・更新経路を使い、旧Hostには501を返す。NextのGit実行fallback・自動再送・稼働サービスの再起動はない。
- Hostは固定repo・固定Git引数、shellなし・credential promptなしで実行し、stderrを公開しない。POSTはHostのdurable command receiptを更新前に保存。切断・Host owner再生成・同じIDの再要求で受付済pullを繰り返さず、同時更新を拒否する。成功pull後の情報再読取失敗・結果不明はunknownを保持する。
- Host control入口はloopback Host・Origin拒否・private marker・method・UUID・body limitを副作用前に検査。metadata/operationの公開projectionで能力情報・任意headersを転送しない。
- Host URL/pathの共通実装を `shared/host-http-client.ts` に分離。Next側はHost discovery metadataのreadFileSyncだけを保持し、Backendのsettings/read/write/path helpersを取り込まない。Cookie/BearerをHostへ転送しない。env/host-control.json/defaultの発見順、loopback制限、testのTemp限定を保持し、credential入りURLも拒否する。
- 共通Hostの8 API入口、folder relay、build-infoを禁止import gateへ追加し、18 roots/82 modulesを監視。health/llamaと画面はまだ旧owner依存が残るため、全本番gate/Phase5全体の完了とはしない。
- 隔離基準d2d752ddと自分の33 pathsのみでWeb213 files/1555 tests、native89 tests、ownership9 tests成功。Backend forced build/runtime型とWeb source-only型も成功。全WebUI/full core suiteの保証ではない。
- 実Next productionの11 source filesのみをビルドし、Backendなし・Cookie認証・Origin拒否・Web停止中のHost受付済更新継続・Web再起動後metadata再読取・同じIDの409/一回だけのpullを11.3秒で確認。Gitは有限fake、receiptはTempの実ファイル、実資格情報・実Git pull・稼働サービス変更はなし。これは実SDK生成中のBackend継続受入ではない。
- 初回Webの2失敗は、credential入りHost URLを新discovery helperが既定Hostへfallbackしていたため。credential/path/query/hashの指定はgeneric errorでfail-closedとし、別Hostへ業務を実行しない。既存2 owner回帰と新discoveryテストを含む213 filesを再検証した。初回fixture cleanupの終了済signal child待機も修正し、実Next停止・再起動試験を再完走した。レビューでUUIDのcanonical形と空日時の拒否も確認した。

## 第4区切り: health診断・llama全入口のowner分離

- `/api/health` はPhase0どおりNextのpublic readiness入口を維持し、SDK/version/model count/cacheはBackendのprivate JSON APIへ移管。匿名時はpath/warnings/任意fieldsを除去、private情報は既存Cookie/Bearer条件で公開。`startedAt` はNext起動世代を維持。Backend不在・世代不一致・応答停止時はSDK snapshotを偽造せず、`backendAvailable:false`・`engineOk:false`・version null/modelCount 0のedge readinessを200で返す。診断HTTPは1秒・128KiBに限定し、Hostの1.5秒probeをSDK待機で止めない。
- llamaのstatus/start/stop、ensure-loaded、modelsをHost private `/webui/llama/*` へ移管。Nextはauth/Origin/method/byte/deadline・公開DTO/operation ID検査・一回のopaque HTTPのみ。Host側でlaunch設定検証・保存済モデル選択・allowlist内のbounded FS走査/cache・load coalescing・durable admissionを担当し、Next roleを副作用前に拒否する。
- 入力64KiB/応答128KiB、Origin拒否/private marker/canonical UUIDをHostで再検査。start/stopは同時実行拒否、受付済同IDはHost owner再生成後も再実行しない。loadはHostに残りHTTP切断で取消さず、loadingモデルを再POSTせず同一server rootで共有。pendingはロード受付・待機終了であり、engineのロード完了を意味しない。起動/停止後のhealth cache invalidationもHost→Backendのprivate HTTPでbest effort通知し、Backend不在でHost制御を止めない。
- pure llama settings/DTOを `shared/llama-server-settings.mjs` + `.d.mts` へ分離、旧Web/Backend pathはshared re-exportへ変更。元TSからのruntime emitとtype宣言を保持し、画面からBackend helperへのvalue importを除去。旧Webのモデルload実装は撤去、既存走査/load回帰はHost実装を直接検証する。
- 禁止import gateは22 roots/90 runtime modulesへ拡張。Backend forced build/runtime型、Web source-only型、native210件成功。独立BackendがWeb source/packageなしでSDK/runtime APIを提供する既存fixtureも1/1成功（16.3秒）。
- 実Next productionで4 API routes/113 source filesをbuildし、匿名/private health投影・Backend不在のreadiness・Hostモデル一覧・Web停止/再起動中のload保持と一回だけのload POSTを1/1成功（13.8秒）。Backend metadata callbackとllama engineは有限fake、Hostのreceipt/scanはTemp実ファイル。実資格情報・実model load・実provider/engine・稼働サービス変更はなく、実SDK生成継続の最終受入ではない。
- 初回nativeのruntime attach2件はbundle build前の試験順序で失敗し、build後に再実行して成功。health fixtureの初回2件は継承したgeneration pinが原因で、fixture限定で明示的に空にし再検証。production copierは許可済HTTP依存undiciを拒否していたため修正した。レビューでSDK診断待ちがreadinessを阻害するリスクを確認し、1秒deadlineと停止Backend回帰を追加した。

## 第5区切り: 全画面のBackend値依存撤去・SSR設定HTTP化

- 画面閉包の棚卸しで、純粋表示・入力schema・ブラウザ設定cache等がBackend互換wrapperを経由し、thinking-levels経由のSDK値importとlayoutからの設定ストア直読を持つことを確認。59モジュールを `shared/ui/`、pure Core4モジュールを `shared/ui-core/` に移管し、Web/Backend/Coreの旧pathはshared re-exportを保持。ブラウザcacheの正本は引き続きBackendの設定。Backendのモデル能力判定・SDK clampだけはBackend thinking-levelsに残す。
- layoutの `readSettingsSnapshot` 直読を廃止し、既存Backend `/internal/configuration/settings` をSSRから一回だけ読む。Cookie/Bearer認証条件、internal bearer/protocol、世代pin、deadline1.5秒・応答4MiB・DTO/prototype key検査を維持。browser資格情報・任意headersをBackendに転送しない。失敗時はundefinedでブラウザの既存hydrateへ委ね、Nextのローカル設定・保存・再送へfallbackしない。RSCへ渡す値は検証済みplain objectとする。
- loginのpath表記はFS/owner helperから切り離したpure shared formatterへ変更し、文字列仕様は維持。Root layoutのhostname表示だけはstatic named hostname importを限定許可し、他のOS能力へ権限を広げない。表示文言・style・構造は変更しない。
- `check-next-ui-boundary` は全render convention/client directiveを自動発見し、145 roots/349 runtime modulesの推移的値importを検査。Backend/SDK/store/native/process/非literal loadingとroot/asset escapeを拒否し、既存transport gate22/90とともにcompiler準備後・既存.next退避前のbuild gateへ組み込み。API全閉包・型依存・manifestからのSDK除去の完了を意味しない。
- 隔離基準fab908a3＋対象差分だけでBackend forced build/runtime型・Web source-only型成功。pure TS58個はimport pathを除くruntime emitが元実装と完全一致、pure Core4個の本体bytes（EOL除外）も一致。SDK thinking回帰・設定cache/Auto/effort・SSR境界の再検証成功。native70件成功。
- 広域Web332 files/2921 testsは331 files/2920 tests成功、ConversationLayoutのscroll follow1件だけ失敗。変更なしHEADを別Tempへ展開し、同じ500対1200の失敗を再現したため今回の回帰としては修正せず、全Web成功とは主張しない。SettingsViewの既存happy-dom localhost通信拒否ログも隠さない。
- 実Next productionで実UI page/layout全体をbuildし、既存MainLayoutClient・思考dropdownをrender。匿名SSRはBackend設定読取0、Cookie callerだけowner値を受け、Web停止/再起動後は更新したowner snapshotを表示、internal token非露出・Next data directory未生成を1/1成功（18.2秒）。有限fake設定ownerであり実provider/SDK生成継続の最終受入ではない。初回fixtureはResponseでないowner返値、次はRSCでnull-prototype DTOを渡す問題で失敗し、契約修正後に再検証した。
- Backend SDK関数のimportはWeb alias誤解決を避けてrelativeへ変更。並行harness差分とは異なるimport1行だけを隔離展開・限定stageし、他者のoverload実装は含めない。実サービス停止/再起動、実資格情報、課金生成、installed package変更は行わない。

## 第6区切り: 全Next入口・型閉包の境界と本番workspace独立化

- 全165 route棚卸しで、status診断のownership表示が未使用のBot count・Backend ownership moduleまでimportしていた。Nextの診断は常にclientなので `ownsRuntime:false` とし、業務互換relayを本番閉包から除去。秘密・認証・generation診断の契約は維持。
- `check-next-entry-boundary` はAPI/render/client/proxy/instrumentationに加えmetadata routeを自動発見し、312 roots/165 routes/583 runtime modulesを検査。type-only import/export/import queryと隣接.d.mtsまで含む649 modulesもWeb/sharedだけに制限。非literal・間接loader、builtin loader、code評価・owner escape・symlink・path referenceを回帰で拒否。個別transport22 rootsだけの検査ではなく、全本番入口をbuild前に検査する。
- public DTO28型を `shared/ui-owner-dtos.ts` に移管。Backend/Coreは元pathで型をimport/re-exportし、UIは直接sharedを参照する。型本体28個と38ファイルのruntime emit（EOL正規化後）がHEADと同一。型経由で設定・認証・SDK・ストアのownerソースをNextへ持ち込まない。
- mirrorからBackend/Core/runtime-src/extensionコピーを撤去し、旧mirror残骸もprune。対象owner checkoutへのoverlapとweb内のreserved path拒否は維持し、checkout・node_modules・既存.nextは侵さない。本番型検査は自動発見した入口だけを起点とし、unused compatibility/test wrapperとowner aliasを除外。Web buildはBackendバージョン検査・extension installを呼ばず、これらのHost担当処理は保持。不要serverExternalPackagesのSDK/provider/native例外も除去。
- 実Next生成後の型検査で19 optional request署名の不適合を検出し、16 routeファイルの引数型だけrequiredへ修正（runtime emit同一）。build-webは並列precheck後に生成route型も再検査し、compiler欠落・生成型失敗をfail-closed/既存build復旧とする。
- ba589faa＋自分の差分だけの隔離でBackend forced build/runtime型、native109件、関連Web68 files/535 tests成功。build後型gate追加の最新境界回帰11件も成功。広域全Web suiteの成功とはしない。追加した既存service-independence試験のimage HTTP envelope期待は `undefined !== 404` で失敗し、未変更HEADの別Tempでも同じ行・同じ失敗を再現したため無関係修正せず記録。既存SettingsView localhost通信拒否ログも保持。
- full production mirrorにはBackend/extension sourceもSDK/provider/SQLite/jiti package pathも置かず、全165 API・実UIをNext build。build前/生成後のstrict型成功、179 NFT traceにowner/SDK/nativeなし。匿名status401、認証callerのowner snapshot・秘密非露出、Web停止中の独立Backend readiness、Web再起動後の応答、Backend不在時の失敗表示、Next data未生成を1/1成功（57.0秒）。有限設定owner callbackであり実SDK生成継続の最終受入ではない。初回の生成型不適合とfixture自身のhealth URL/protocol誤り、native fixture cleanup失敗、status旧mock期待を修正して再検証した。

## 残る作業

- Web manifest/lockfileから不要SDK/provider/SQLite等を除去し、HostのSDK version gate/updater同期をBackend専有に変更する。テストのSDK依存はBackend側へ解決/分離する。installed packageと稼働サービスは今回変更していない。
- 隔離した実Backend/実Nextで、生成実行中のWeb停止/再起動、Backend PID/世代/SDK session/lease継続、再接続後の履歴・完了結果・受付済operationの非再実行を確認する。register関数だけの子プロセス試験は、この最終受入の代用にしない。

実資格情報・課金生成・稼働サービスの停止/再起動は検証に使わない。他セッションのharness/GoalLoop/provider-overload差分を混ぜない。
