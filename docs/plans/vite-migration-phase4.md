# P4: 禁止依存検査・Next撤去

## 状態

**P4の完了判定は撤回し、反例の補修・独立再検証中**。`74c678ae`でもcomputed destructuringからFunctionを取得でき、Browser/gatewayのsource/bundle gateが拒否しない反例を確認した。禁止依存gateの先行導入とNext撤去、および過去に実施した検証は以下の履歴として保持するが、条件3の成立を保証しない。稼働Host/Backendの切替・実SDK更新・物理操作の保証は含まない。以下のturn 1–3は撤去前の履歴。

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

## 引継ぎ後に判明したdestructuring拒否漏れの補修

- 原因: `dependencyReferences`はproperty/element accessを検査する一方、BindingElementの非literal computed key・引用付きconstructorと、ObjectLiteralExpressionで表現される代入destructuringを検査していなかった。`const key = ["constr", "uctor"].join(""); const { [key]: run } = () => {}; run("globalThis.canary = true")();`は隔離VMでcanaryを実行し、Browser/gatewayのsource/bundle全4条件を通った。function prototypeを右辺にした反例も同様。
- 補修: 宣言・関数引数・入れ子・代入・for-in/of/await-of destructuringのkeyを検査。非literal keyとloader/constructor抽出、未追跡reflection getterの抽出を拒否する。通常のobject constructionとliteralな業務property抽出は維持。gatewayのtype-only/Undici監査、metadataのhash/origin限定例外は変更しない。
- 回帰: unitに19負例と6正常例をBrowser/gateway・source/bundleで追加。実clean install＋Vite build fixtureにvendorの宣言/代入destructuring拒否とfirst-party workerの出力前拒否を追加。今回の隔離基準は`74c678ae`＋対象3source/testのみ。他者のGoal Loop・未追跡provider-overload差分は含めない。
- 隔離証拠: `%LOCALAPPDATA%/Temp/p4-handoff-validation/`。`baseline-unsafe-build.log` / `rerun-state.json`で旧HEADの実Vite buildはexit 0、canaryが生成JSに残ることを確認。修正版の`bundle-integration-fixed.log`は正常build＋vendor負例8件＋first-party拒否3件が成功し、unsafe JS/indexを出力しない。初回のintegrationは追加時の引用符誤りで構文失敗したため修正・再実行し、初回log/stateは保持した。
- 最終sourceのisolated再検証はunit24件、SPA型、新gateが成功。Browser337 value/525 type、gateway166 routes/267 operations/254 value/486 type、Undici固定41 files、framework9 manifest/lock/2344 source。clean offline installは311 packages、正常のproduction buildと拒否fixture内のinstallにはNextなし。`final-state.json`の4コマンドは全exit 0、`final-bundle-integration.log`で最終sourceでも正常build＋vendor拒否8件＋first-party拒否3件を再確認（331.6秒）。
- 独立したレビュー工程で差分・許可/拒否条件・テスト・証拠を再照合。for-in/ofの代入pattern漏れとliteral numeric keyの過剰拒否を補修してunitを追加し、最終sourceで上記全検証を再実行した。`review.json`で検証source3ファイルのSHA256と作業treeのbyte一致、対象4ファイルのUTF-8無BOM/LF round-trip、初回失敗log保持を確認する。別セッションへのread-onlyレビュー依頼は応答timeoutで、外部レビュー済みとは主張しない。
- 今回はP4全体の完了ではなく、destructuring反例の補修。Backend/SDK更新独立性・2世代build/start/rollback・UI/stream matrixはこのターンで再実行しておらず、上記履歴の証拠と区別する。稼働サービスの変更・Pushなし。

## 引継ぎturn 2: local call / return経由のglobal拒否漏れ

- 原因: emitted Browserでglobalをlocal functionへ渡すことを許可していた一方、parameter・return・function aliasを追跡していなかった。`function invoke(root) { root[key](code); } invoke(globalThis)`とidentity helperの返却値は隔離VMでcanaryを実行し、`ba8f91c1`のgateを通った。旧HEADの実vendor production buildもexit 0で、canaryが生成JSに残った（`p4-turn2-validation/baseline-unsafe-build.log`、`state.json`）。
- 補修: symbol単位のglobal taintをlocal functionのpositional parameter・default parameter・return・function alias・comma expressionへ固定点で伝播する。unknown targetがknown helperと混在しても落とさず拒否する。object/array/rest/unknown callへの未追跡escapeを拒否し、通常のDOM helper・boolean/文字列データ利用は保持する。
- 初回の厳格化は正常Reactのevent target・Symbol iterator・private DOM slots・callback/Map cacheも拒否した。compiler出力6chunksをprivate Tempへ採取して原因を照合した。string prefixやSymbol名による一般的な許可を試したが最終実装には残していない。正常処理のglobal-flow/global-readとMap/WeakMapのgetだけを、既存のReact 19.1.0固定SHA256＋実compiler originへ限定して保存する。constructor/descriptorの従来5site許可とは別で、任意vendor・copied call形・変更されたReact bytesへの許可ではない。既知loader名・constructor・Reflect getterの拒否は維持する。
- 回帰: local/global flowの25負例と10正常例、pinned React provenanceの正常/変更/他source/明示eval負例を追加。新`browser-global-flow.integration.test.mjs`はclean installと正常production build後、argument・return・function alias・遅延定義helper・React origin偽装mapの5実vendor負例を拒否し、index/unsafe JSを出力しないことを検証する。raw vendor mapは既存load hookで除去し、mapは公開しない。
- 最終隔離基準は`ba8f91c1`＋対象5source/testだけ。peerのGoal Loop/provider-overload差分と一時debug helperは含めない。初回の正常build拒否はlog/stateに保持する。`%LOCALAPPDATA%/Temp/p4-turn2-validation/final-state.json`の5コマンドは全exit 0。clean offline ci311 packages、unit26件、SPA型、新gate、正常production build＋実vendor拒否4件が成功（integration173.3秒、合計27テスト）。レビューで、AST上のhelper宣言より前にfunction bodyを走査した場合の固定点更新漏れを確認し、assignments収集の新規辺でも再走査するよう補修した。遅延定義helperの負例/正常例を追加し、`review-rerun-state.json`の最終5コマンドは全exit 0。最終source5件でもclean install・unit26件・型・gate・正常build・5実vendor拒否が成功した（integration249.9秒、合計27テスト）。Browser337/525、gateway166/267・254/486・Undici41、framework9 manifest/lock・2345 sourceを確認。検証5sourceと作業treeのSHA256一致・対象6ファイルのUTF-8無BOM/LFを`review.json`で照合する。
- 独立したレビュー工程でsymbol候補・unknown混在・global escape・pin/compiler provenanceと負例を再確認した。今回の修正ではconstructor/descriptorの既存許可位置やframework packageを変更していない。Map getの許可は固定React sourceの実call位置だけで、Reflect aliasには適用しない。外部レビュー済みとは主張しない。
- P4全体の完了ではない。SDK更新/Backend build/2世代/stream matrixは今回再実行しておらず、過去の証拠と区別する。残存する間接loader/function capability経路と7条件の独立再検証を継続する。稼働サービスの変更・Pushなし。

## 引継ぎturn 3: function / prototype capabilityのlocal flow補修

- 原因: globalとは別に、function/prototypeをlocal parameterやreturnへ渡した場合のcapabilityを追跡していなかった。`function invoke(fn) { fn[key](code)(); } invoke(()=>{})`、identity返却、prototype引数、通常object prototypeのconstructor連鎖は隔離VMでcanaryを実行し、`b62eef51`のBrowser/gateway・source/bundle全4条件を通った。旧HEADの実vendor buildもexit 0でcanaryが生成JSに残った（`p4-turn3-validation/state.json`、`baseline-unsafe-build.log`）。
- 補修: symbol単位のfunction/prototype taintをpositional/default parameter・return・alias・comma/conditional/logical expressionへ固定点で伝播する。class/functionのprototypeと通常object prototypeもconstructor capabilityとして追跡する。既存の`fn.constructor.prototype`拒否を維持する。call/apply/bindとliteral array spreadの引数位置を正規化し、bound prefixは候補ごとに保持する。部分bind・多段bindで後続引数を先頭parameterへ誤配線しない。own call/apply/bind上書き・unknown target・非literal spreadはglobalのknown-local許可へ紛れ込ませない。独立レビューで、prototype mutationによるwrapper置換をnormalizationだけでは証明できないことを確認した。wrapper正規化はcapability伝播だけに使い、global escapeの新規許可には使わない。無bound引数のbind aliasもこの拒否を維持する。正常Reactの既存hash/origin限定flow以外はfail closed。
- 厳格化の初回は正常unistのfunction/array/object overloadとunifiedのcallable prototype選択を拒否した（`integration.log`、初回stateを保持）。private compiler出力を採取し、originと実sourceを照合した。`unist-util-is/lib/index.js`の`tests[index]`/`checkAsRecord[key]`、`unified/lib/callable-instance.js`の`proto[property]`だけを固定SHA256＋実compiler originのfunction-readへ限定する。前者はobject/arrayに絞ったbranch、後者の本番Processor callerは`copy`選択。global-flow/global-read、constructor/descriptorの一般許可には拡張しない。任意vendor・copied形・hash改変・map欠落・位置不一致をunitで拒否する。既知loader名と明示constructorはpin位置でも拒否する。
- 回帰: function/prototypeの26隔離VM負例と14正常例、実Browser/gatewayのvalue閉包10拒否fixtureとgateway build前拒否、3site provenanceを追加した。最終の`review-rerun-state.json`は6コマンド全exit 0。clean offline ci311 packages、unit29件・SPA型・新gate、正常build＋function/prototype vendor拒否6件（291.8秒）、旧global-flowの正常build＋vendor拒否5件（254.7秒）が成功し、unsafe JS/indexを出力しない。合計31テスト。Browser337/525、gateway166 routes/267 operations・254/486・Undici41、framework9 manifest/lock・2346 source。隔離基準は`b62eef51` archive＋今回の5source/testだけで、peerのGoal Loop/provider-overload差分は含めない。検証5sourceとworking treeのSHA256一致、対象6ファイルのUTF-8無BOM/LF、初回の正常build拒否log保持と限定stageを`review.json`で照合する。外部レビュー済みとは主張しない。
- 残存: plain-object computed値のconstructor連鎖、callのthis receiver、rest配列経由について、現修正でも隔離VM canaryが実行されprimitive gate全4条件を通ることを確認した（`residual.json`）。これらの実build通過は今回未検証で、今回のpositional/return flow補修とは分離する。P4条件3の全成立・P4完了は主張しない。SDK更新/Backend build/2世代/stream matrixも今回未再実行。Phase5へ進めず、次の修正と7条件の再検証を継続する。稼働サービス変更・Pushなし。

## 引継ぎturn 4: rest / lexical argumentsの添字capability補修

- 原因: local functionのrest parameter/implicit argumentsと、その添字取得を追跡していなかった。`function invoke(...args) { args[0][key](code)(); } invoke(()=>{})`は隔離VMでcanaryを実行し、`56582d24`のBrowser/gateway・source/bundle全4条件を通った。旧HEADの実vendor buildもexit 0でcanaryが生成JSに残った（`p4-turn4-validation/state.json`、`baseline-unsafe-build.log`）。
- 補修: known-local呼出しのargument slotをAST値集合として固定点に記録し、restの開始位置・implicit argumentsのlexical owner・宣言/代入alias・local array helper parameter・default array・conditional/logical/comma containerを解決する。arrowは外側argumentsを継承し、normal nested functionとargumentsのlocal shadowは別に扱う。function/prototype/globalの添字投影をreturnとaliasへ伝播する。globalをpositional parameterとして受けてarguments[0]から返すescapeも拒否する。globalへのrest/unknown/wrapper許可は追加しない。metadataのhash/origin許可・manifest/lockは変更しない。
- 初回の正常build監査は90秒timeoutになった。alias graphの経路列挙を、全到達候補を保持する重複なしworklistと固定点ごとのprojection cacheに置換した。functionValue側の宣言/代入の再帰展開もやめ、既存の固定点binderへ一元化した。28段diamond aliasの拒否/正常fixtureを追加し、8条件合計約72msで成功した。初回`integration.log`/stateは保持する。新規argument edgeとparameter value edgeの追加はchangedを立て、cacheを次周で必ず再計算する。
- 回帰: 22隔離VM負例・11正常例・arguments由来global returnの3拒否、dense aliasの拒否/正常例を追加。Browser/gatewayの実value閉包へrest/arguments/helperの6拒否を追加し、gatewayはcompiler/staging前に拒否する。新`browser-argument-slots.integration.test.mjs`は正常clean build後にrest・arguments・返却・lexical arrow・array helperの実vendor負例を拒否する。最終隔離検証はoffline clean install（311 packages）、unit 31件、SPA型、gate、新5＋既存function 6＋global 5実vendor拒否の全7 commandがexit 0・done:trueで成功（計34 tests、正常build成功、unsafe index/JSなし）。証跡は`%LOCALAPPDATA%/Temp/p4-turn4-validation/final-state.json`、`final-*.log`、`review.json`（source 3 hash・4 file UTF-8/no BOM/LF・外部reviewなし・P4全体受入なし）。現sourceと隔離sourceのbyte一致・限定stage・diff --checkを確認する。隔離基準は`56582d24` archive＋対象3source/testで、peer差分・未追跡provider-overloadを含めない。
- 残存: plain-object computed値、this receiver、restを非literal spreadとして別helperへforwardする経路は、現sourceでもVM canaryが実行されprimitive gate全4条件を通る（`residual.json`）。これらの実buildは今回未検証。今回のknown-local添字投影を全variadic flow/任意JS sandboxへ拡大して主張しない。SDK更新/Backend build/2世代/stream matrixも今回未再実行。P4は未完了、Phase5へ進めない。稼働サービス変更・Pushなし。

## 引継ぎturn 5: nonliteral variadic forwardのcapability補修

- 原因: `invocation`は非literal spreadがあるとknown-local targetをnullへ落とし、非literal applyの引数配列も空扱いにしていた。`forward(...args) { sink(...args); }`、`sink.apply(null, arguments)`、array aliasのspreadは隔離VM canaryを実行し、`9b4001a8`のBrowser/gateway・source/bundle全4条件を通る。旧HEADの実vendor production buildもexit 0でcanaryが生成JSに残った（`p4-turn5-validation/baseline-repro.json`、`state.json`、`baseline-unsafe-build.log`）。
- 補修: known-local targetとunknown候補を維持し、nonliteral iterableの候補値をvariadic slotへ固定点伝播する。幅が未知のspreadは位置の下限を保持して以降の全slot/parameterへ保守的に伝播し、restの任意添字とlexical argumentsも取りこぼさない。prefix/bound prefixとspread後のscalar引数は別に処理する。applyのarray alias、rest/arguments/宣言・代入alias、arrow lexical owner、nested array spread、conditional/logical container、複数helperとreturnを追跡する。wrapper/variadicの正規化は伝播のみで、globalのknown-local escape許可へ追加しない（`!wrapped && !variadic`）。metadata hash/origin site・manifest/lock・owner実装・CLIは変更しない。
- 回帰: 20隔離VM負例・9正常例を全4gate条件で検証。globalのvariadic前後位置・arguments経由spread/applyの4拒否も検証する。Browser/gatewayの実value閉包へspread/apply/array aliasの6拒否を追加し、gateway compiler/staging前の拒否を維持する。新`browser-variadic-flow.integration.test.mjs`はclean install・正常build後、rest forward/apply/array alias/nested spread/bound prefix/later rest indexの6実vendor負例を拒否し、unsafe JS/indexを出力しない。
- 隔離証跡: `%LOCALAPPDATA%/Temp/p4-turn5-validation/`。基準は`9b4001a8` archive＋対象3source/testで、peer差分・未追跡provider-overloadを含めない。`state.json`の全6 commandがexit 0・done:true。offline ci311 packages、unit32件、SPA型、production boundary gate、正常build＋実vendor6拒否が成功（integration284.5秒、計33 tests）。旧baselineのunsafe出力を成功証拠で上書きしない。検証source3 SHA256と現treeのbyte一致・4 file UTF-8/no BOM/LF・限定stage・diff --checkを`review.json`で照合する。外部レビュー済みとは主張しない。
- 残存: plain-object computed値とthis receiverは現sourceでもVM canaryを実行しprimitive gate全4条件を通る（`residual.json`、実buildは今回未検証）。custom iterator、未知callee、objectのarray-like applyや任意JSの全variadic flowを今回のknown-local iterable追跡だけで証明しない。SDK更新/Backend build/2世代/stream matrix・既存3 integrationの実build matrixは今回再実行しておらず過去の証拠と区別する。P4全7条件の完了は主張せず、Phase5へ進めない。稼働サービス変更・Pushなし。

## 引継ぎturn 6: this receiverのcapability補修

- 原因: call/apply/bindのpositional argumentは追跡していたがthis receiverを記録していなかった。`invoke.call(()=>{})`のbodyから`this[key](code)()`を実行する反例は隔離VM canaryを実行し、`5e40edfc`のBrowser/gateway・source/bundle全4条件を通る。旧HEADの実vendor production buildもexit 0でcanaryが生成JSに残った（`p4-turn6-validation/baseline-repro.json`、`state.json`、`baseline-unsafe-build.log`）。
- 補修: known-local targetごとにexplicit receiverのAST候補集合を固定点へ記録し、function/prototype/global capabilityをthis・宣言/代入alias・return・nested helperへ伝播する。arrowはnearest ordinary functionのthisを継承し、call/apply/bindのreceiverを無視する。normal nested functionは別scope。binding候補ごとに最初のbound receiverを保存し、multi-bindと後続call/applyで上書きしない。bind()の省略receiverもbound状態を保持する。positional/bound prefix・variadic・unknown候補とglobal逃避拒否の既存規則は変更しない。metadata hash/origin site・manifest/lock・owner実装・CLIは変更しない。
- 回帰: 18隔離VM負例・9正常例を全4gate条件で検証。global receiver/parameter由来call/apply/bindとthis returnの4拒否も検証する。Browser/gatewayの実value閉包へcall/apply/bindの6拒否を追加し、gateway compiler/staging前の拒否を維持する。新`browser-this-flow.integration.test.mjs`は正常clean build後、call/apply/bind/multi-bind/lexical arrow/this returnの6実vendor負例を拒否し、unsafe JS/indexを出力しない。
- 隔離証跡: `%LOCALAPPDATA%/Temp/p4-turn6-validation/`。基準は`5e40edfc` archive＋対象3source/testで、peer差分・未追跡provider-overloadを含めない。`state.json`の全6 commandがexit 0・done:true。offline ci311 packages、unit33件、SPA型、production boundary gate、正常build＋実vendor6拒否が成功（integration284.0秒、計34 tests）。旧baselineのunsafe出力を成功証拠で上書きしない。検証source3 SHA256と現treeのbyte一致・4 file UTF-8/no BOM/LF・限定stage・diff --checkを`review.json`で照合する。外部レビュー済みとは主張しない。
- 残存: plain-object computed値は現sourceでもVM canaryを実行しprimitive gate全4条件を通る（`residual.json`、実buildは今回未検証）。未知callee・property-held method・implicit default this等の全JS receiver flowをknown-local wrapper追跡だけで証明しない。SDK更新/Backend build/2世代/stream matrixと既存実build integration matrixは今回再実行しておらず、過去の証拠と区別する。P4全7条件の完了は主張せず、Phase5へ進めない。稼働サービス変更・Pushなし。

## 引継ぎturn 7: 合成computedキーによるplain-object constructor抽出

- 原因: computed keyの文字列解決はliteralと直接の`+`だけで、`const key=["constr","uctor"].join("")`を解決しなかった。plain-objectの`data[key][key](code)()`はVM canaryを実行し、`74db1a26`のBrowser/gateway・source/bundle全4条件を通る。旧HEADの実vendor production buildもexit 0でcanaryが生成JSに残った（`p4-turn7-validation/baseline-repro.json`、`state.json`、`baseline-unsafe-build.log`）。
- 補修: 合成キーの既知文字列候補とunknown候補を分離。literal-array join、fragment/宣言・代入alias、local parameter候補、object literal property、concat、conditional/logical/commaを解析し、constructor/loaderの候補が1つでもあれば拒否する。unknownと併存する候補を捨てない。候補解析は拒否だけを追加し、exact-keyを要求する既存箇所は従来のliteral/直接concatだけの判定を保持する。新しい許可には使わない。alias unionは重複なしworklist、complete queryとacyclic exact結果だけcacheし、循環をexact permissionにしない。候補数/文字列長に上限があり、任意JS文字列生成の完全解析ではない。
- 一般的なobject/constructor/evaluator taintも試したが、正常なnested data readとReact/Markdownのcallbackを誤検出した。その方式とnumeric/Symbolの補助判定は最終sourceから外した。正常vendorへの新しいshape/string/Symbol許可やhash/origin exemptionは追加していない。初回unit失敗と正常build拒否は`state.json`、`pre-regex-*`、`pre-key-refinement-*`、`pre-scalar-decoder-*`へ保持する。
- 回帰: 32 VM負例（型assertionはVM実行時だけerasure）・14正常例を全4条件で確認。既知キーとunknownの混在、再代入、分岐、concat/join/alias、wrapper・default・rest・arguments・thisを含む。ただしキーが既知constructorとして拒否された証拠であり、一般的なobject/receiver flowの証明ではない。Browser/gateway閉包へ3拒否fixtureを追加し、gateway compiler/staging前拒否を維持する。新`browser-object-flow.integration.test.mjs`はclean install・正常build後に4実vendor負例を拒否し、unsafe JS/indexを出力しないことを検査する。
- 隔離基準は`74db1a26` archive＋対象3source/testだけ。peerのGoal Loop/provider-overload差分を含めない。最終証跡は`%LOCALAPPDATA%/Temp/p4-turn7-validation/final-state.json`、`final-*.log`、`review.json`。最終sourceのunit34件・SPA型・gate・正常build＋実vendor4拒否は全4 command exit 0・done:true（integration209.1秒、計35 tests）。offline ci311 packagesも成功。source3件のSHA256/byte一致、4 file UTF-8/no BOM/LF、限定stageをレビューで照合する。install/旧unsafe build証拠は元の`state.json`とlogを参照し、成功で上書きしない。外部レビュー済み・P4全体受入済みとは主張しない。
- 残存: `String.fromCharCode`で不透明に生成したキーと返却closureを組み合わせる反例は、現sourceでもVM canaryを実行してprimitive gate全4条件を通る（`residual.json`、実build未検証）。不透明キーの一般object flow、higher-order invocation target、未知callee/property-held method等は未証明。SDK更新/Backend build/2世代/stream matrixと既存実build integration matrixは今回未再実行。P4全7条件は未完了、Phase5へ進めない。稼働サービス変更・Pushなし。

## 引継ぎturn 8: 返却functionの高階callee target伝播

- 原因: `functionBindings`はidentifier/直接function/bindだけを解決し、factoryの返却functionやfunction-valued parameterをcallee targetへ戻していなかった。不透明キーで`make()(fn)`、`make(fn)()[key](code)()`、nested factory、返却normal functionのthis receiverを使う5反例はVM canaryを実行し、`02447d94`のBrowser/gateway・source/bundle全4条件を通った。
- 実buildの旧baselineは別の結果だった。direct invokerとclosure返却の2 vendor fixtureは旧bundle gateが拒否し、unsafe JS出力は確認していない（`state.json`/`baseline-unsafe-build.log`、`baseline-retry.json`/`baseline-retry-build.log`）。primitive gate通過と実build通過を同一視しない。最初のvalidation runnerはbaselineが通る前提で停止し、その失敗を保持した。
- 補修: functionごとに返却binding候補を固定点保存し、call result・parameter/default・nested factory・conditional/logical/comma・宣言/代入aliasからtargetを伝播する。bindingごとのbound prefixと最初のthis receiverを保持し、unknown候補も残す。新しい高階/parameter/分岐targetは`wrapped:true`として伝播だけに使い、既存global escape許可へ追加しない。metadata hash/origin site・manifest/lock・owner実装・CLIは変更しない。
- 性能: 最初の正常buildは90秒timeoutになった（`pre-worklist-state.json`、`pre-worklist-integration.log`）。alias経路の再帰列挙を重複なしworklistへ置換し、binding候補の重複を除去、固定点ごとのcomplete query cacheを導入した。wrapper適用順とprefix/receiverの異なる候補は別状態として保持する。循環call/aliasはunknownとして扱い、返却registryの512候補/128 bound引数上限とrecursive bindをfail closedにする。28段diamond callback aliasの負例/正常例を全4条件で確認する。
- 回帰: 20 VM負例・9正常例・global escape非拡張4負例・recursive-bound拒否・diamond回帰。Browser/gatewayの実閉包へ返却invoker/receiverの2拒否fixtureを追加し、compiler/staging前拒否を維持する。新`browser-returned-functions.integration.test.mjs`はclean install・正常build後、返却invoker/closure/receiver/bound prefixの4 vendor負例を拒否し、unsafe JS/indexがないことを検査する。
- 隔離基準は`02447d94` archive＋対象3source/testだけ。peer差分を含めない。証跡は`%LOCALAPPDATA%/Temp/p4-turn8-validation/final-state.json`、`final-*.log`、`review.json`。offline ci311 packages、unit35件・SPA型・gate・正常build＋4 vendor拒否が成功（integration232.1秒、計36 tests）。レビューで閉包fixture2例のkeyをturn7で解決済みのjoinからopaque keyへ直し、隔離unit35件を再実行して成功（`review-unit-rerun.log`）。production/integration sourceは不変のため実build結果を再利用し、その範囲をstateへ明記した。source3件のSHA256/byte一致と4 file UTF-8/no BOM/LF、限定stageを照合する。installと旧baseline拒否は元state/logに保持し、最終結果で上書きしない。外部レビュー済みとは主張しない。
- 残存: 不透明キーでplain-objectの継承constructorを取得する直接/closure反例は、現sourceでもVM canaryを実行してprimitive gate全4条件を通る（`residual.json`、実build未検証）。返却callee targetの補修を一般object capability/未知callee/property-held method/async factoryの全追跡として主張しない。SDK更新/Backend build/2世代/stream matrixと既存実build integration matrixは今回未再実行。P4全7条件は未完了、Phase5へ進めない。稼働サービス変更・Pushなし。

## 引継ぎturn 9: 不透明キーによるplain-object constructor抽出のdecode拡張

- 原因: turn7のkey解決はliteral・直接concat・literal-array joinなどに限られ、`String.fromCharCode`/`fromCodePoint`、`decodeURIComponent`、`String#slice/substring/substr/at/charAt`、spread配列、定数畳み込みで作ったキーを解決しなかった。`const key=String.fromCharCode(99,...,114); const first={}[key]; first[key](code)()`はVM canaryを実行し、turn9基準HEAD`fd750984`（turn8`0691401a`は祖先）のBrowser/gateway・source/bundle全4条件を通った（`p4-turn9-validation/baseline-repro.json`、`my-fix-repro.json`）。
- 旧baselineの実build結果も保持する: primitive gate 4条件はすべて通過したが、実vendor buildはexit 1でcompilerが拒否し、unsafe JS出力は確認していない（`baselinePrimitiveGateAcceptCounts`、`baselineCompilerRefused:true`、`baselineEmittedUnsafeJavaScript:false`、`baseline-unsafe-build.log`）。primitive gate通過と実build通過を同一視しない。
- 補修: key候補decodeを拒否専用のまま拡張した。`String.fromCharCode`/`String.fromCodePoint`（literal配列・`containerValues`/代入aliasを含むspread引数）、`decodeURIComponent`/`decodeURI`、組み込み文字列の`slice/substring/substr/at/charAt`、literal配列の`join`を評価し、`constantNumber`で数値の定数畳み込み（単項±、`+ - * / % **`、32bit上限）を行う。組み込み判定は`localMethod`/新`localValue`でshadowingを除外し、decode不能な入力はunknownへ落とす。候補上限・文字列長上限はturn7の既存制限を維持する。receiver/this/alias経路のtaint伝播機（`objectState`等）も試作したが、正常vendor chunkを誤検出する実build阻害（`healthy-build.log`の`indirect loader/constructor`）を起こしたため、decode規則だけを残して削除した。一般object accessをfunction扱いへ広げない。
- 回帰: 新test「opaque object constructor chains retain refusal states without tainting ordinary callbacks」で30 VM負例（object/array/string/number box、再代入、alias、call/apply/bind、rest/arguments/this、switch/conditional/logical/comma、default parameter、factory返却、fromCodePoint/join/slice/substring/decodeURIComponent/spread/定数式）と18正常例（unknown key、nested data read、数値index、`String.fromCharCode`で作った非constructor文字列、shadow済み組み込み、`constructor:null`のproperty access）をBrowser/gateway × source/bundleの4条件で確認する。Browser/gateway閉包の拒否fixtureへ直接/closure反例2件を追加した。
- 隔離基準は`fd750984` archive＋対象3source/testだけ。peer差分（Goal Loop/provider-overload）を含めない。証跡は`%LOCALAPPDATA%/Temp/p4-turn9-validation/state.json`、`baseline-unsafe-build.log`、`healthy-build.log`、`unit.log`、`gate.log`、`integration.log`、`review.json`。offline clean install、unit36件、SPA型検査、gate、正常build、実vendor4拒否がすべてexit 0・done:true（integration224.9秒、vendorRefusals4、`emittedUnsafeJavaScript:false`）。レビューで追加検出した5残存キー合成反例（fromCodePoint/spread/定数式/decodeURIComponent/slice）も補修後に全4条件で拒否する（`review.json`の`residualAcceptedGateModes: []`）。3 source/testのSHA256はvalidation stateと一致し、BOM/CRLFなし。
- 残存: decodeは有限の組み込み形だけを対象とし、任意JS文字列生成の完全解析ではない（`atob`、`Buffer`、自作関数、template literalの動的値等は未検証）。返却bind/unknown callee/property-held method/async factory、一般object capability flowは未証明。SDK更新/Backend build/2世代/stream matrixと既存実build integration matrixは今回未再実行。P4全7条件は未完了、Phase5へ進めない。稼働サービス変更・Pushなし。外部レビュー済みとは主張しない。

## 引継ぎturn 10: 不透明キーの文字列/配列/レコードdecode拡張

- 原因: turn9のdecode表面は literal・直接concat・`String.fromCharCode`・`slice`等に限られ、template literal、`concat`、`split`+`join`、`Array.from`、spread、`replace`/`replaceAll`、暗黙変換、返却値経由の関数呼び出し、destructuring、`Object.fromEntries`/`Object.keys`等で合成したキーを解決しなかった。約55のキー合成形をVM canary付きで走査した結果、turn9基準HEAD`e60ab670`では約35形がBrowser/gateway × source/bundleの全4条件を通った（`p4-turn10-validation/baseline-probe.log`）。
- 補修: 引き続き拒否専用のまま、`keyCandidates`のdecode表面を1回の包括的な置換で拡張した。template literal（式/raw）、`concat`、`split`+`join`、`Array.from`、配列spread、`slice`/`reverse`、`replace`/`replaceAll`、`padStart`/`padEnd`、`toUpperCase`/`toLowerCase`/`trim*`/`valueOf`/`toString`、`JSON.parse`、`String()`/`new String()`、`Object.keys`/`getOwnPropertyNames`/`Reflect.ownKeys`、`Object.fromEntries`、配列/オブジェクトdestructuring、単一return式のローカル関数/arrowのinline評価（引数frame置換、`arguments`使用時と引数再代入はunknown）を対象に追加した。decode不能入力は従来どおりunknownへ落とし、`substitutions` frameが有効な間はcacheを無効化して呼び出し依存のdecodeを混在させない。
- 回帰: 新test「synthesized constructor keys from string, array and record decoding stay refused」で29 VM負例（template/concat/split+join/Array.from/spread/padEnd/toLowerCase/trimStart/String.raw/定数式/slice/decodeURIComponent/unescape/JSON.parse/new String/Object.keys/Reflect.ownKeys/返却関数/destructuring/fromEntries/index等）と22正常例（非constructor文字列、shadow済み組み込み、unknown key、nested data、`constructor:null`等）を4条件で確認する。`scripts/browser-object-constructor.integration.test.mjs`の実build probeを6形（direct/template/concat/split-join/returned-call/fromEntries）へ拡張し、各probeで`dist-spa`未生成と拒否メッセージを個別diagnosticに記録する。
- 隔離基準は`e60ab670` archive＋対象3source/testだけ。peer差分を含めない。証跡は`%LOCALAPPDATA%/Temp/p4-turn10-validation/state.json`、`baseline-probe.log`、`unit.log`、`gate.log`、`healthy-build.log`、`integration.log`、`review.json`。offline clean install、unit37件、SPA型検査、gate、正常build、実vendor6拒否がすべてexit 0・done:true（integration350.6秒、vendorRefusals6、`emittedUnsafeJavaScript:false`、`healthyEmittedProbe:false`）。変更前HEADの実build probe6形はprimitive gate 4条件をすべて通過する一方で実vendor buildはexit 1で拒否し、unsafe JS出力は確認していない（`baselinePrimitiveGateAcceptCounts:[4,4,4,4,4,4]`、`baselineCompilerRefused:true`、`baselineEmittedUnsafeJavaScript:false`）。レビューで残存反例0（`review.json`の`residualAcceptedGateModes: []`、`fixedAllRefused:true`、`positivesAllAccepted:true`）と3 source/testのSHA256/byte一致・BOM/CRLFなしを確認した。作業コピーがCRLF化していたためLFへ戻して検証を再実行した。
- 残存: decodeは有限の組み込み形のみで、loop内`charCodeAt`・`reduce`/`map`等のcallback集約・`Symbol('constructor')`のtoString/slice合成・`atob`/`Buffer`・自作関数/template動的値の全般は未解決。返却bind/unknown callee/property-held method/async factory、一般object capability flowは未証明。SDK更新/Backend build/2世代/stream matrixと既存実build integration matrixは今回未再実行。P4全7条件は未完了、Phase5へ進めない。稼働サービス変更・Pushなし。外部レビュー済みとは主張しない。

## 次の確認範囲

P4の不透明キー/object・未追跡callee反例の補修と受入7条件の独立再検証。成立前にPhase5へ進めない。その後にPhase5の確定HEAD隔離受入matrixと独立した総合回帰/運用レビュー。稼働generationの切替・実SDK deployment/update・physical tray/Tailscale/audio・power-lossは別途明示操作と検証が必要。静的な境界と有限fixtureは任意JavaScriptの完全sandbox、same-user攻撃への完全防御を証明しない。
