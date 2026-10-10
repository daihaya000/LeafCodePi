# P4: 禁止依存検査・Next撤去

## 状態

**P4の受入対象は完了**。禁止依存gateを先行導入後、Next package/config/生成型参照/import/mock、旧bridge/checker/builder/mirrorを撤去。Nextなしのclean install・型・native build/start・stream・Backend/SDK独立性を確認した。稼働Host/Backendの切替・実SDK更新・物理操作の保証は含まない。以下のturn 1–3は撤去前の履歴。

## 先行gate

- `scripts/production-boundary.mjs`: first-party value graph、コンパイラが解決したtype graph、literal dynamic import、type-only/re-export/import(type)、triple-slash参照、canonical pathを検査。
- BrowserはNode builtin/ambient Node、Backend/Host/extensions、Pi SDK、Next、API/旧platform bridgeを拒否。`types`はReactに限定。`process`は3個のcompile-time置換だけを宣言し、runtime polyfillは作らない。
- Browserの実Rollup module IDsと出力chunkもVite pluginで検査。TypeScriptとViteのneutral aliasを合わせ、TTS/llama/Host表示契約からNodeのOS既定値を分離。Backendの既存facadeはOS既定値とexport名を保持する。
- gatewayは全inventory routeから閉包を作り、`scripts/gateway-contracts.json`の監査済transport/DTO 135ファイルだけを許可。未知のshared store、filesystem mutation、loader alias、eval/Function、computed global loader、非literal importを拒否。
- generation/discovery readerはnamed `readFileSync`限定。static snapshotは既存のnamed readerと`O_RDONLY | (O_NOFOLLOW ?? 0)`だけを許可し、openのalias/write flagを拒否。
- gateway型packageはUndici/undici-types/@types/nodeだけ。隔離fixtureが借りる型依存はchecker自身のWeb dependency treeに限定し、未知owner directoryへのlinkは許可しない。
- `build-spa-worker.mjs` / Vite本番build / `build-gateway.mjs`に組込み。gatewayはstaging/output書込みより前に拒否し、`typecheck:false`でも迂回不可。CLIは `npm --prefix web run check:production`。
- native ESMはhost-probe routeをprocessごとにcacheするため、旧Next/HMR用global identity cacheだけを除去した。UI構造・CSS・business/SDK ownerは変更していない。

## この単位の検証

証拠は `%LOCALAPPDATA%/Temp/p4-gate-{validation,rerun,final-tests}` と `p4-backend-control-fresh`。

- 新gate 9テスト（多数の拒否fixture）と旧startup/transport/UI/entry/gateway検査: 48件成功。
- 新gateの再実行9件成功。実閉包はBrowser first-party 337 / type 525、gateway first-party 253 / type 516、166 routes / 267 operations。
- clean offline installから2つの実SPA/gateway世代をbuild/seal。失敗build・起動失敗時の旧世代保持/復旧を確認。500 sealed files。Backend/Host/SDK packageなし。
- 実native production gateway/browser、実開発SPA 6画面・optimizer 72応答・CSS HMR成功。開発pageErrors 0、未送信draft維持、別Vite listenerなし。
- SPA型チェック成功。TTS/llama/Host hint/共有型/host-probe/旧SPA境界のWeb回帰73件 / 8ファイル成功。
- Web directoryのない隔離checkoutでBackend runtime build成功。最新sourceをbuildした実Backend entry/harness/SDK/session/leaseのfinite provider probe成功。旧SDK testのtop-level Next検査importだけを**一時コピー**から外してprobe分岐を実行し、リポジトリのテストは変更していない。

### 失敗の切り分け

- 初回の新bundle gateは`web/index.html`をsource許可範囲外として拒否した。明示entryとして許可し、実buildを再実行して成功。
- Vitestのproduction preview probeは`NODE_ENV=test`でReact development stack helperをbundleし、Function拒否に当たった。本番workerと同じ`NODE_ENV=production`に揃え、拒否規則を緩めず再実行。source/type検査が増えた同probeのdeadlineは90秒。
- 旧Webless service fixtureは画像404のresponse envelope assertionで失敗。今回の共有3ファイルをHEAD版に戻した**隔離コピーでも同一失敗**を再現。無関係なBackend/stream契約は修正しない。
- 既存checkoutのcache済runtimeによる旧SDK probeはlistenまで到達しなかった。cache/live Backendを変更せず、隔離fresh buildでprobe成功。cache側の原因は未特定で、fresh成功と区別する。

## 外部runtime閉包の補完（turn 2）

- 原因: first-party gateは外部Undici entryで探索を打ち切っていた。通常の`undici/index.js`は未使用のSQLite cache storeやmockも読み込むため、単なるpackage名の許可では境界が閉じない。
- `web/src/lib/gateway-http.mjs`と`.d.mts`をtransport専用facadeとして追加。Agent/Client/fetchの3個のprivate entryと、対応する狭いpublic型だけを利用する。raw dispatch / timeout / abortの挙動は維持し、Undici全体のbarrelをgatewayから除いた。SSE/file relay 4ファイルと2つのmockだけを更新。
- `scripts/gateway-runtime-boundary.mjs`はliteral CJS require / ESM / dynamic importを再帰探索し、symlink・非literal/間接loader・eval・store mutationを拒否。`gateway-runtime-contracts.json`はUndici 8.10.2のmanifestと41個の到達ファイル、依存辺、native capabilityをSHA256固定。変更・難読化された追加コードにも再監査を要求する。自動更新・自動承認はしない。
- cache/mock/SQLite storeのファイル、filesystem/process launcher/VMはこの41ファイルに到達しない。`node:sqlite`のliteralは固定版のruntime-feature判定表だけに残る。到達するcallerはcrypto判定だけで、DB生成/更新はなく、`DatabaseSync`取得を許可していない。transport以外の一般的なSQLite permissionではない。
- llhttp WASMの固定2バイナリ/HTTP parser callback、WebIDLのFunction prototype brand check、Undiciの2個のsymbol-keyed global slotだけは、正確なファイルhashとAST文脈付きで許可。first-partyのeval/Function/任意WASM/global loader拒否は緩めない。
- 新gateはworkspaceのpackageを検査し、generation builderはclean gateway installの**実stage packageを再検査してからseal**する。旧検査は維持し、facade限定のsubpath permissionだけを追加。旧checkerの単独import・外部compiler provisionも維持。
- gateway vendor型も`skipLibCheck`に依存せずimport/type-query/参照directiveを検査。未解決SDK・未知の外部型・相対owner escapeを拒否。隔離fixtureのコピー対象に`.d.mts` sidecarを追加し、型推論への誤ったfallbackを避けた。
- `gateway-runtime-boundary.test.mjs`6件成功（固定閉包、CJS/dynamic/type-only、変更/間接/難読化、transitive、manifest、内外symlink、未解決vendor型、build前拒否/既存output保持）。新/旧gate 34件、relay回帰23件、SPA型検査成功。Browserは337/525、gateway first-partyは254 / type 486、外部valueは41ファイル、166 routes / 267 operations。
- 実native production browser test成功。元Nextとの917件の正確なAPI比較も成功（有限Host/settings/tasks/command/SSE/Range/HEAD、実課金SDKなし）。Webなしのfresh Backend buildと実entry/harness/SDK/session/lease probeも成功。
- 初回fixtureはsidecar未コピー、旧checkerは新helper未コピーで失敗した。fixtureの依存閉包と旧checker単独importを直して再実行。間接require拒否fixtureの初回失敗は例外messageの正規表現不一致で、拒否規則を緩めていない。
- 初回2世代build中にこの作業のsource変更が入り、snapshot不一致として正しく拒否された。固定sourceで再実行し、2世代build/sealと失敗時の旧世代保持/復旧を確認。最終sourceの再実行は全group exit 0（2世代は146.7秒、501 sealed files、復旧確認）。結果は`%LOCALAPPDATA%/Temp/p4-runtime-final/`。
- SDK probeの初回は15秒のlisten deadlineに到達。原因は未特定。一時コピーにchildログと45秒deadlineを加えた再実行は4.03秒で成功。Backendや実稼働cacheは修正していない。証拠は`p4-runtime-backend-debug/`、その他は`p4-runtime-{validation,rerun,final}/`。

## 本番CLI/compilerの切替（turn 3）

- `scripts/build-web.mjs`をpaired SPA/native gateway build CLIへ置換。`--offline` / `--mirror <.spa directory>`だけを受け付け、seal/publication後のgeneration IDをJSONで返す。稼働Host/BackendへのrestartやSDK操作はしない。
- `scripts/start-production-gateway.mjs`は検証済generationのnative childだけを起動する。build/install/dev fallbackなし。port/hostname/mirrorを明示指定でき、起動失敗時は既存paired fallbackを利用する。新native entryはIPC parent lossでlistenerを閉じる。
- `web/package.json`のstart/typecheck/check CLIをnative start、SPA config、新Browser/gateway gateへ切替。root buildとWeb buildは同じnative pair入口。Next dependencyと旧tsconfigはこの単位では残す。
- `build-gateway.mjs`のvalue edge抽出とcompiler-resolved型検査を新gateへ完全移行。`gatewayGraph()`入口で拒否するため`typecheck:false`でも迂回できない。Next専用checkerへのimportなし。
- mirror root/slugを`build-workspace.mjs`、Hostのextension準備を`extension-dependencies.mjs`へ分離し、Host・SPA pair builderから旧Next helperへの依存を除いた。既存cache key/extension repairの挙動は維持する。
- 旧builderを`legacy-next-build.mjs`へ隔離し、直接CLI実行は拒否。旧startup/transport/UI/entry検査の比較fixtureだけが参照する。本番CLIからの静的到達性検査で旧builder/checker/mirror/Nextへの辺を拒否する。旧fixture/helper自体の削除は次の単位。
- 検証: CLI/helper/runtime/generation unit 117件、native production browser、SPA型検査、実headless Hostのnative gateway restart/crash recoveryと実Backend SDK/session/lease/heartbeat維持が成功。実CLIでclean offline installから2世代build/seal（501 files、161.7秒）、canonical start、7画面、失敗build/起動後の旧paired generation復旧を確認。
- 新/旧gate groupは初回47/48件成功。原因: gatewayの隔離fixtureがvalue source/sidecarだけをコピーし、新compilerが解決する3個のerased-type依存を欠いた。shared型閉包をfixtureへコピーし、拒否規則を緩めず当該2テストを再実行して成功。証拠: `%LOCALAPPDATA%/Temp/p4-cli-validation/`、当該再実行は `node --test scripts/build-gateway.test.mjs`。
- actual CLI clean installにはNext packageがまだ含まれる。成功は**Next-free installの証明ではない**。UI/CSS変更、live切替、実SDK更新はしていない。

## Next撤去（turn 4）

- Web manifest/lockから`next`、`@next/*`、`eslint-config-next`を除去。Next config/plugin/生成型参照・tsbuildinfo、未到達のSSR layout/proxy/instrumentation/settings snapshot/compression monkeypatch、`platform` bridgeを撤去。UIは既存SPA adapterへ直接bindし、CSS・business処理を変更しない。`next-themes`はNext非依存のReact部品として維持する。
- 新value/type/runtime gateで拒否・実build成立を確認した後、旧Next checker/builder/mirrorと専用fixtureを削除。Host workspace/extension repair/lifecycleの有効な16件は`host/src/build-workspace.test.js`へ移設。cold/generated streamとSDK継続性の実integrationはcompiled native gatewayへ移行し、捨てていない。
- `framework-free.mjs`はroot/Web/gateway/Backend/Hostの9 manifest/lock、2344 sourceをAST監査。package alias/nested override、type-only/re-export/import(type)/import-equals、literal dynamic/require/mock/resolve、config/plugin復活、source symlinkを拒否。data内の拒否fixture文字列はimportとして誤検出しない。source/type/runtime閉包gateを置き換えるものではない。
- paired compilerは外部workspaceのTypeScriptで元checkoutも監査する。snapshotから除外されるtest/owner manifestの復活もbuild前に拒否し、workerはtransport snapshotを別途検査する。rootにWeb dependenciesが未導入でも、workspaceのclean install後に実行できる。
- auth504件、cookie serialization9件/parsing6件、compression347件は`349f0640`の実装から撤去前に独立採取した固定golden。Next runtimeの再install不要。owner handler testのRequestはBackend native adapterと同じURL annotationを持つfixtureのみで、framework module mockはない。

### 最終検証

証拠: `%LOCALAPPDATA%/Temp/p4-next-free-verified/`（`state.json`・各log）。修正前の失敗は`p4-next-free-{validation,final}/`と区別する。

- `npm --prefix web ci --ignore-scripts --no-audit --no-fund`:311 packages/16秒。実installed treeに`next`・`@next`・`eslint-config-next`なし。新lockから外部workspaceもclean offline install成功。
- 新境界/復活拒否/ownership/Host helper/世代/CLI/golden:228件成功。変更対象のWeb144ファイル/1295件成功。SPA型検査成功。neutral ESLintでnavigation/JSON relayの関連lint成功。旧repository全体の型検査・全lint・無関係なpeer testの成功は主張しない。
- Browser337 value/525 type、gateway166 routes/267 operations/254 value/486 type、Undici8.10.2の41 runtime filesを再監査。未知owner/SDK/store/間接loader/type-only/symlink拒否を維持。
- canonical CLIで2世代をbuild/seal/start（501 files、143.2秒）。7 URL、稼働中旧世代のimmutable bytes、失敗build/start後のpaired rollbackを確認。実native production browserとcold開発SPA6画面・optimizer/auth/CSS HMRも成功。実headless Hostのgateway restart/crash recoveryでもBackend SDK/session/lease/heartbeatを維持（101.6秒、provider call1、外部fetch転送なし）。
- native cold stream:269584138-byte transcript、536870912-byte file、125002ms SSE/550064915 bytes、32 SSE cuts・8 scan cuts・16 file cuts、foreign lease polling、Range/HEAD/reconnect/restartとreader/descriptor/queue解放が成功。
- native generated stream:539148152-byte profile、536870912-byte TTS、125013ms Provider SSE/534295090 bytes、各reader8 heartbeat、切断/取消/再接続/再起動、bounded heap/queue・非再実行・owner resource解放が成功。TTSは隔離finite engineで、実課金providerではない。
- Web directoryのないfresh checkoutでBackend runtime build、実SDK/AgentSession/session/leaseのfinite providerが成功。gateway停止/再起動中のPID/generation/session/token/heartbeat維持、SDK結果2回各一度、SSE再接続、operation replay3回拒否、外部fetch転送0を確認。Backend SDK更新/rollback/CLI/Webなしの32ケースも成功。live SDK install/updateはしていない。

### 失敗・修正の根拠

- 原因:移設したowner bundleのESM SDK解決先とcompiled route manifestの階層が不一致。隔離fixtureへBackend依存だけを結び、`buildGateway`の実outputからmanifest/serverを読み込むよう修正。両長時間streamを再実行して成功。
- 原因:Next削除後の一部testに未定義`NextRequest`、またはowner用`nextUrl` annotation欠落が残った。standard Request/owner fixtureへ限定移行し、1295件を再実行して成功。既存ownership testのhealth/cacheと119-route/184-operation inventory前提も現transport構造に合わせた。
- 検証中のsource変更で一度SDK integrationのSPA snapshotが拒否された。境界を緩めずsource固定で再実行し成功。peerの長時間harness-limit-fallback testは変更せず、当該実行だけ停止・所有対象から除外した。
- peerのGoal Loop testはRequest移行だけHEAD基準でstageし、35行の意味変更と他の既存差分をコミットに含めない。indexだけをTempへ展開し、peerの3未追跡shared sourceがないことを確認。Nextなしの実clean offline install・両境界/型・stage済Goal/JSON relay63件・Webなし実SDK probeも成功（`p4-index-{review,clean-review}/`）。借用Web dependency symlinkの初回は正しくescape拒否されたため、拒否規則を変更せず実installへ切替。
- この範囲はP4受入。Phase5の全HTTP/UI/secret matrixの確定HEAD隔離受入を代替しない。

## 独立検証で判明したbundle拒否漏れの補修（turn 6）

- 原因: `dependencyReferences(..., { bundled: true })`がglobal receiver/aliasの検査を省略していた。`9cd3b67a`の隔離clean install後、到達する`next-themes`へ`Reflect.get(globalThis, "eval")`を追加しても実production buildはexit 0で、呼び出しが生成JSに残った。従来のP4完了報告だけでは条件3を満たしていなかった。独立した再現証拠: `%LOCALAPPDATA%/Temp/p4-independent-audit-sMXs7F/`。
- 補修: emitted Browser値にもglobal receiver・symbol単位のalias・reflection getter alias・連結されたloader名を検査。constructorの一括例外をやめ、prototype metadata/代入/boolean guardとReactのEvent clone形だけに限定した。`@ungap/structured-clone`の動的constructorは、6個の危険型をthrowする正確な2-statement guard形だけを許可し、guard削除・break化・constructor抽出は拒否する。型/first-party/Undiciの既存境界を緩めていない。
- 新しいunitは23個のbundle loader/eval負例、4個のguard改変負例と8個の正常metadata/DOM例を追加。`browser-bundle-boundary.integration.test.mjs`は実clean offline installと正常build後にvendorへ同じcanaryを注入し、型/first-party gateは通るが実production buildが拒否し、unsafe JSもindexも出力しないことを確認する。canaryをBrowserで実行したり公開したりしない。
- 最終証拠: `%LOCALAPPDATA%/Temp/p4-bundle-fix-8ZOTG3/`。baseは`9cd3b67a`のarchive、上書きは今回のgate/unit/integrationだけ。peerの差分・未追跡sourceを取り込まない。初回integrationは`NODE_ENV=production`のnpmがdev dependenciesを省略しViteを欠いて失敗したため、fixtureの`ci --include=dev`を明示し、`vendor-eval-rerun.json`/`.log`で再実行exit 0。`state.json`の初回失敗を成功に書き換えていない。

| 条件 | 今回の観測 |
| --- | --- |
| 1 Browser value/type | first-party 337/type 525、実production bundleのmodule ID/値監査と新vendor拒否fixture成功。Node/owner/SDKの既存負例も成功 |
| 2 gateway value/type | 166 routes/267 operations、first-party 254/type 486、Undici 8.10.2の固定41 files。業務/SDK/store/OS capability拒否成功 |
| 3 erased/dynamic/indirect/eval/link | 既存type-only/dynamic/内外symlink負例、新bundle reflection/alias/constructor負例と実vendor eval拒否成功 |
| 4 Next撤去 | 9 manifest/lockと2342 sourceを監査。Next/@next/eslint-config-nextの実installなし、canonical native CLIの到達性検査成功 |
| 5 clean/build/types/gates | clean offline ci 311 packages、SPA型、新gate等35件、Web build/secret/preview18件、2実世代build/seal/start/rollback（501 files・7 URL）、実native browser42 direct/reload/HEAD・2 viewport成功 |
| 6 Backend/SDK独立 | Webなしfresh Backend buildと実SDK/AgentSession/lease成功。gateway再起動中もPID/generation/session/token/heartbeat維持、結果2回各一度・replay3拒否・外部fetch転送0。更新/rollback32テスト成功。実稼働SDK更新はしていない |
| 7 撤去順序 | Git履歴で`c3131257`の新gate/build組込み、`bbb5d21f`の外部runtime拒否追加時には旧checkerが残り、`9cd3b67a`で撤去。今回の補修で新たな旧検査削除なし |

- 最終の関連検証は合計89テスト成功（35 unit、18 Web、32 SDK更新、4 integration）。native production browser、Webless SDK、2世代CLIとvendor拒否の各logを確認した。UI/CSS/business処理、Host/Backend deployment、既存・peer差分は変更していない。有限AST検査/fixtureの範囲を、任意JavaScriptの完全sandboxに拡大して主張しない。

## 2回目の独立検証で判明したmetadata例外の補修（turn 7）

- 原因: `dcc8cfb2`ではdescriptorの非literal keyを無条件に許可し、`new event.constructor(event.type, event)`も形だけで許可していた。隔離VMでは両者からFunctionを取得してcanaryが実行され、実vendor buildもexit 0。first-party descriptor反例はcanonical buildを通りsealed generationまで発行された。独立証拠: `%LOCALAPPDATA%/Temp/p4-dcc8-verify-yEcxTN/review.json`。turn 6の7条件完了判定はこの観測で撤回する。
- 補修: 非literal reflectionは原則拒否。Event clone形だけの許可を廃止し、React 19.1.0/extend 3.0.2の固定SHA256とcompiler source mapで識別する5箇所だけを許可する。Reactのchecked/value tracking、native Event replayとextendの固定`__proto__` guardは元のコードを変えない。既知Function/function prototypeに対するcomputedアクセス・宣言/代入alias・bind派生も拒否する。prototype参照/代入/boolean metadataはloader値抽出ではなく、後続constructor抽出は引き続き拒否する。
- source mapは実入力byteからcompilerが作成する。upstream inline/external map directiveはコメント位置だけを空白化し、文字列・改行・offsetを維持する。productionのoutput hookでhidden mapを強制し、監査後にJS mapを削除する。vendor mapによるReact origin偽装、コピーしたcall形、pinned source改変、map欠落は拒否。map decoderはbuild-onlyの`@jridgewell/trace-mapping@0.3.31`をmanifest/lockで固定した。
- 実build回帰fixtureは正常clean install/build後、global eval・descriptor・Event偽装・computed function・代入alias・精密なReact origin偽装mapの6負例を拒否し、index/unsafe JSを出力しない。元のfirst-party反例はpaired build workerのsource gateでcompiler出力前に拒否する。metadata正常例・bytes改変/無関係origin/位置/map欠落とdirective/string保持は独立unitで検証する。canaryを実Browserや稼働サービスで実行しない。
- 初回の厳格化で正常extendの`__proto__` getterを拒否し、Vite API callerがbuild optionsを上書きした場合はmapを欠いた。正常getterをhash/origin限定監査へ追加し、output hookでmapを強制した。全代入をfunctionとして扱う試行では正常numeric array readも拒否したため、代入taintは既知function prototype由来に限定し、固定numeric keyを許可した。directive処理のJSX text変更もunitで再現してliteral範囲を除外した。初回失敗logは保持し、成功で上書きしない。
- 最終の隔離検証: `%LOCALAPPDATA%/Temp/p4-metadata-fix-V175Xp/`。`dcc8cfb2` archiveに今回の8 source/test/config/manifestを上書きし、peer差分は含めない。全10コマンドexit 0、関連91テスト成功（gate/unit37、Web18、SDK更新32、integration4）。clean offline ci311 packages、Next実installなし、型・新gate・6実vendor負例/first-party source拒否、2世代501 files/7 URL/build/start/rollback、実Browser42 direct/reload/HEAD/2 viewport、WebなしBackend build/実SDK/session/lease/heartbeat/replay拒否を確認した。
- Browser337 value/525 type、gateway166 routes/267 operations/254 value/486 type、Undici固定41 files、framework9 manifest/lock/2344 sourceを再監査。decoder追加以外のlock package entriesに差分なし。`review.json`は検証sourceと作業treeの8ファイルがbyte同一、UTF-8/BOM/EOL契約と7条件を確認した結果。新gate導入`c3131257`/`bbb5d21f`で旧checkerが残り、削除が`9cd3b67a`であることも再確認した。live Host/Backend/SDKの切替・更新は実行していない。

## 次の確認範囲

Phase5の確定HEAD隔離受入matrixと独立した総合回帰/運用レビュー。稼働generationの切替・実SDK deployment/update・physical tray/Tailscale/audio・power-lossは別途明示操作と検証が必要。静的な境界と有限fixtureは任意JavaScriptの完全sandbox、same-user攻撃への完全防御を証明しない。
