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

## 残る作業

- 画面で使うclient-safe helper/型と、Backend業務実装への互換re-exportを分離。実行グラフに残るBackend/SDK依存を特定して撤去し、旧helperの直接呼出しも整理する。
- API/Proxy/画面の本番value import graph全体への禁止import検査を追加し、ブラウザ認証・入口制限・opaque transportだけを残す。テスト専用のBackend owner検証を本番グラフへ混ぜない。
- Web manifest/lockfile/build mirrorから不要SDK/provider/SQLite等を除去。残存client import/型依存・テスト依存を調べずにpackageだけ削除しない。
- 隔離した実Backend/実Nextで、生成実行中のWeb停止/再起動、Backend PID/世代/SDK session/lease継続、再接続後の履歴・完了結果・受付済operationの非再実行を確認する。register関数だけの子プロセス試験は、この最終受入の代用にしない。

実資格情報・課金生成・稼働サービスの停止/再起動は検証に使わない。他セッションのharness/GoalLoop/provider-overload差分を混ぜない。
