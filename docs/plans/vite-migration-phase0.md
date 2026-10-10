# Next → Vite＋React移行：Phase0棚卸し・回帰基準

## 範囲と開始点

- 2026-10-10開始HEAD: `5c7643c448f0410920ff9c3945fc7d6cb6f582f4`。Backend分離の最終受入 `551c494ed20d1281ee5e6f59971e7ebe3887ca00` を巻き戻さない。
- **本書のPhase0〜5はNext→Vite移行。`next-thin-phase*.md`のBackend分離Phaseとは別。** Backend分離の所有権・受入範囲は維持する。
- Phase0の変更は本書、[機械可読対応表](vite-migration-phase0.json)、棚卸しscript/testのみ。Next・manifest・lock・UI・Host・Backend実装、installed package、稼働サービスは変更しない。
- レビュー時に並行作業が`ca7c2a7161e11c9e1ad35288b466dc0404094a5e`をコミットした。startHEADとの差分はBackend原本履歴/ブックマークと関連testsだけで、本番Web/Host閉包のinventory照合は変わらず成功。Phase0をその後へ限定コミットし、他者コミットを巻き戻さない。
- 開始時のstaged差分はなし。同cwdの移行相談・検索/ブックマークUI・session context作業を照合し、編集範囲を連絡した。
- 他者差分（棚卸し資料・検証・コミットへ含めない）: Backend session-memory-guard、server、runtime-srcのtasks/bookmarks/search、get-task-detail-bounded、harness、snapshot-messages、session-history-page、task-transcript、original-ui-history、GoalLoop index/test、Web harness-limit-fallback.test、shared provider-overload本体/型/test。Phase0資料は本番Web閉包だけを採取し、これらのowner変更の完成状態を主張しない。

## 再現可能な棚卸し

```text
node scripts/inventory-vite-migration.mjs
node --test scripts/inventory-vite-migration.test.mjs
```

- デフォルトはread-only。JSONと現在のソース閉包・API一覧・assets・配信関連source digestの一致を検査する。
- 更新時だけ `node scripts/inventory-vite-migration.mjs --write`。ソース差分を先にレビューする。text digestはUTF-8/LF正規化、画像はbyte hash。秘密env値は取得しない。
- JSONの`routes`が**165公開URLすべてのgateway対応表**。各明示methodのowner/action/既存contract/note、暗黙method、直接Next依存、到達するrelay/contract、同directoryの既存tests、比較必須項目を持つ。
- JSONの`frameworkImports`は全本番value/type閉包のNext固有import/API、`pages`はrender入口、`assets`は全public assets＋app画像/CSS、`sources`は根拠のdigest。
- 既存所有権JSONの`note`/`contract`は分類・保存条件であり、全DTO・全statusの実行証明ではない。colocatedTestsの存在もcoverage保証ではない。Phase1でHTTP比較fixtureを作り、未比較操作を成功扱いにしない。
- このscriptは**旧構成のPhase0スナップショット**。後続Phaseで移動/変更したsourceは当然不一致になる。新gateway/browser禁止依存gateに置換するまで旧境界gateを保持し、snapshotを無条件再生成して回帰を消さない。

### 現HEADで確認した件数

| 項目 | 実測 |
|---|---:|
| 全Next入口 | 312 |
| API route / 明示操作 | 165 / 265 |
| 本番runtime / type modules | 583 / 649 |
| Backend owner / Host owner / gateway edge操作 | 239 / 20 / 6 |
| 明示contract: JSON / SSE / empty / binary / mixed | 242 / 5 / 9 / 8 / 1 |
| UI page / assets（CSS含む） | 7 / 22 |
| GET由来の暗黙HEAD / 暗黙OPTIONS route | 94 / 164 |

265操作だけを実装して終わらせない。installed Nextの`auto-implement-methods.js`と全routeで比較し、GET由来HEADのhandler選択・body抑制、OPTIONSの204とsorted Allow、未許可methodの405を維持する。例外の明示OPTIONSはhost-probe。未知path、末尾slash、percent decode、大小文字、static優先順位、予約methodの処理はPhase1の実HTTP比較へ追加する。

## 棚卸し後の構成判断

**gatewayはNode HTTP＋標準Request/Responseを第一案とする。追加HTTPサーバframeworkは導入しない。**

根拠: 165入口はすでに薄いrelay/edge。Node builtin、既存undici、shared契約を再利用できる。NextRequestは大半が型用途、JSON/Cookie/redirectが主要置換点。Node↔Web Streams adapterの成立をPhase1の最初のgateとし、不成立なら具体的不足を記録して方式を再判断する。Phase0ではgatewayを実装・起動しない。

```text
Browser: Vite buildした既存React SPA
   │ 同一origin /api/*
   ▼
独立Web gateway: HTTP入口・認証・静的配信
   ├─ Backend: SDK / 業務 / 設定・保存 / session / lease
   └─ Host: プロセス監視 / 更新・Git / llama等の制御
```

- 想定配置: `web/`はVite/React、`gateway/`は独立server entry/manifest/type/build/test、`shared/`は既存pure DTO/契約。gateway business owner禁止。SDK更新・業務データ正本はBackend、プロセスownerはHostのまま。
- 既存relayはNextを使わないtransport部分をgateway側へ移し、Next handlerと新gateway handlerから比較期間だけ共用する。全面互換NextRequest shimや恒久的Next風routerは作らない。
- TypeScript gateway buildは既存compilerを使用する案。emit/bundleとmanifest/lockの確定はPhase1。build依存を本番server依存と混同しない。
- Browser routingはReact Routerの最小browser routerを第一案とする。7URLと既存TaskPanes URL監視の整合をPhase2で固定する。現時点では依存追加しない。
- Viteはdev/buildのみ。本番にVite dev/previewを起動しない。前build復旧は保持するが、Hostの現行`next dev`自動fallbackを本番Vite devへ機械置換しない。前buildなしは明示失敗、開発modeのみ別起動にする。

## API/gateway対応・例外経路

全method別対応は[JSON `routes`](vite-migration-phase0.json)。対応表のownerは最終処理owner、gatewayActionは入口の責務で、実装完了印ではない。

| 既存入口群・根拠 | gateway担当 |
|---|---|
| `configuration-relay.ts`、configuration contract | 設定/通知/profile mutation入口。認証・Origin・local transfer条件・サイズ・mutation receipt/保存後反映失敗DTOを維持。Backendストアを読書きしない |
| `json-business-relay.ts`、各shared contract | JSON業務のopaque中継・command UUID・公開DTO検証・generation/deadline。peer bearerを専用内部headerへ分離。ローカルfallback/盲目的再送なし |
| `live-event-relay.ts`、`backend-runtime-events.ts`、`provider-auth-events-relay.ts` | SSE headers/Last-Event-ID/再接続・切断・購読cleanup。配信切断はSDK abortではない |
| `task-file-stream-relay.ts`、`backend-file-transport.ts` | 9routeのbinary/mixed配信。Range/If-Range/HEAD、cache、Content-Disposition、encoding、backpressure。全体buffer禁止 |
| `host-*relay.ts`、Host直接HTTPを使うroute | folder dialog/build-info/llama/pi/翻訳/Host管理をHostへ。owner不在・protocol/generation不一致を失敗として返す |
| `POST /api/auth/webui` | Cookie・ログイン制限だけをgatewayに保持 |
| `GET /api/health`、`GET /api/backend/status` | Web readinessとBackend診断投影。SDK/OS業務samplingを移さない |
| `GET/OPTIONS /api/host-probe` | gateway process固有random ID・private Origin/PNA応答 |
| `POST /api/projects/[id]/explorer` | 既存403拒否。遠隔起動の新中継を作らない |

### 認証・Originの保存基準

- 正本: `web/src/proxy.ts`、`shared/webui-auth{,-shared}.ts`、`shared/same-origin.ts`、route/relay個別制約。
- `LEAFCODE_PI_WEBUI_AUTH=required`ならtoken欠落もfail-closed。proxyではBearer優先、route helperはBearer/Cookieの両方を検証する。この差を無断統一しない。
- Cookie: `leafcode-pi-token`、HttpOnly、SameSite=Lax、Path=/、Max-Age=31536000。現在Secure/Domainは未指定。認証済Cookieの更新、Host webui-auth変更によるCookie削除も比較する。移行ついでの属性変更は別要件。
- 公開例外: `/login`、`/api/auth/webui`のprefix、exact `/api/health`、`/api/host-probe`、`/api/peer-auth/{list,resolve,usage}`、`/_next/` prefix、exact `/favicon.ico`。proxy matcherで`/_next/static`・`/_next/image`は除外。公開peerは匿名業務許可ではなくBackendのpeer認証へ渡す。
- `/_next/*`はフレームワーク配信だけの旧例外。Viteのhash付きassetsへ置換し、任意ファイル/API/SPAを公開するprefixに流用しない。`/icon.svg`等の既存asset認証も棚卸し通りに分類する。
- 非APIのquery tokenは消してno-store/no-referrer redirect、fragment tokenはLoginFormがhistoryから消してPOST。safe `next`判定、login loop回避、Cookie認証済loginのredirectを保持する。
- 全APIへ新たな一律Origin条件を課して互換性を変えない。各relayのsame-origin、loopback transfer、private CORS/PNA、peer bearerを個別保存する。X-Forwarded-*の信頼や逆proxyのURL復元もadapter比較対象。
- backend/host bearer・protocol・generation pinはserverのみ。ブラウザ由来の内部context headersを信頼しない。`VITE_*`・HTML・bundle・source mapに秘密値を含めない。公開build metadataは現在のcommit/dateに限定する。

### HTTP adapterの最初の受入gate（Phase1）

- Node IncomingMessage → Request: raw URL/query/authority、headers/cookie、GET/HEAD無body、streaming bodyのduplex、aborted/close状態。正常request body完了を切断と誤認しない。
- Response → ServerResponse: 複数Set-Cookieを分離、header大小文字/重複、status、HEAD bodyなし、Content-Length/Content-Encoding、flush、backpressure。abort/cancel/error/close時のreader・socket・timer cleanup。
- SSEをJSONbuffer/compressionへ通さない。長時間body timeoutと有限header timeoutを区別し、Web停止が受付済生成を取り消さない。
- static route優先（`/tasks/.../search`等をdynamic IDと誤認しない）、params decode一回、未知API404・未許可method405・OPTIONS/Allow・認証前後の順序をNext実HTTPと比較する。
- Next固有機能の置換以外は既存relayのdeadline/サイズ/DTO/protocolを変えない。既存configuration relay等のabort/deadline制御差も一律改善せず、比較で確認して必要変更を限定する。

## UI・routing・SSR・assets

### 維持するURL

| URL | 現在の画面/仕組み | 移行先 |
|---|---|---|
| `/` | Home、TaskPanesHost経由 | SPA page＋同じpane provider |
| `/task/[id]` | pageはnull、pathname監視でpaneを初期化 | ID URLとpane復元を維持。単独TaskViewへ作り直さない |
| `/settings` | Settings、split pane | 同じsettings/pane状態 |
| `/bots` | BotListView | 同じcomponent |
| `/bots/[id]` | async paramsからBotView | router paramsから同じcomponent |
| `/bots/rooms/[roomId]` | async paramsからRoomView | static rooms優先＋router params |
| `/login` | Suspense＋LoginForm | 同じform/query/hash処理 |

直URL、reload、戻る/進む、replace/push、login後refresh相当、URL変更とTaskPanes内部選択、同一URLクリック、query/hash、未知画面404をPhase2/3で比較する。OAuthは画面URLに新pageを作らず、既存provider login/callback/answer/SSE契約とSDK側listenerを棚卸し元通りに保つ。実認証は別途承認、fixture callbackで比較する。

### Next固有依存の置換範囲

- `next/navigation`: 11本番files（LoginForm、BotList/Bot/Room/Home、AppShell、GlobalAttention、Sidebar、TaskPanesContext、ForkButton、TaskPanesHost）。pathname/searchParams/push/replace/refreshとpane/history連動を置換。
- `next/link`: 4files（BotCodeSessionPanel、BotListView、BotMessageList、Sidebar）。modifier/middle click、外部URL、tab、accessibilityを保つ。
- `next/image`: MobileMenuHeaderの1file。元asset・寸法・layout・altを保つimg。`/_next/image`旧URLを新UIへ残さない。
- `next/dynamic`: TaskPanesHostの1file。既存6ビューのssr:false/loading/遅延mountをReact lazy/Suspenseへ置換し、paneの再mount/既存状態消失を防ぐ。
- `next/headers`: `(app)/layout.tsx`の1file。SSR設定取得を認証後HTTP bootstrapへ置換。
- `next`型のMetadata/Viewport: root layoutのみ。`lang=ja`、viewport-fit、theme-color、favicon/apple icon、descriptionと`LCP <hostname>`表示を保つ。hostnameはNodeをbundleへ入れずgatewayの公開表示DTOで受ける。認証済画面のmetadataを公開HTMLへ無断露出しない。
- `next-themes`: ThemeProviderとui hook。package名だけでNext依存と断定せず、React-only到達性をPhase4で確認して残すか同契約に置換。light/dark/oyster/system・storage key・初回theme適用・flashを維持。
- `instrumentation.ts`: process role指定とhttp-compression-fixだけ。gateway roleはowner gateで拒否されるclient roleとし、Node配信でcompression fixが必要か実測してから限定撤去。
- `use client`、async server page/layout、RSC prop輸送、Next型/テストmockは新runtime契約へ置換。CSS/token/DOM・componentの業務的操作は改修しない。

### 設定bootstrapは最優先リスク

現行順序: `(app)/layout` → internal settings HTTP（1.5秒・4MiB・DTO検証）→ MainLayoutClient/AppShell → `primeServerSettings` → `initializeComposerDefaults`。SSR失敗時は既定値適用後に`hydrateServerSettings`へ進む。

SPAへSSRだけ外すと、`AppShell.initializeBoot`が毎回後者を選び、server snapshotより先に既定値writerを動かす。**Phase2では認証後に既存`GET /api/settings`からsnapshotを取得・検証してから既存AppShellをmountすることを第一案**とする。hostname等を加えるbootstrap経路は名前/DTOを別途固定し、既存APIを変えない。

受入: 保存済非default値、未送信pending、取得遅延/失敗/401、古いsnapshot、タブ復帰、ユーザー入力との競合、StrictMode再mount、localStorage拒否の各条件で無操作の初回起動が保存値を上書きしない。失敗時は取得待ち/再試行の明示状態、成功前の既定値の自動保存は禁止する。既存localStorage/sessionStorageキー、tab/pane/draft、CustomEvent/visibility、SSE shared hubを維持する。

## Host・build・本番/dev配信契約

| 現行根拠 | 保存条件 / 置換箇所 |
|---|---|
| root/web package scripts | root devはNext dev 127.0.0.1:3010、buildはbuild-web、startはNext start。Vite buildとgateway独立startへ置換。SDK syncはBackendのみ |
| `scripts/build-web.mjs` | mirror同期、禁止依存・source型gate、build前.next退避/失敗復旧、生成型再検査、公開commit/date stamp。Next生成型は新browser/gateway型gateへ置換後に除去 |
| `scripts/web-build-mirror.mjs` | repo外のlocal workspace、独立source copy、owner/SDK不コピー、overlap拒否、installed deps分離。新gateway成果物＋Vite distを同世代でpublishし、途中buildを配信しない |
| `host/src/index.js` | `buildWeb`/`spawnWeb`/`stopWeb`/`restartWeb`、Next CLI readiness、orphan pid識別、webProc監視、restore launchを新entryへ限定変更 |
| `host/src/config.js` | port既定3010（LEAFCODE_PI_PORT）、control18775、Backend18776。bindHostとTailscale/loopback proxy・認証判定を維持 |
| `host/src/web-plan.js` | .next/BUILD_ID、Next config、src/public/shared mtimeによるstale判定を新artifact fingerprintへ置換。legacy backend/core監視は到達性検査後に限定除去 |
| readiness | Hostは`GET /api/health`を1.5秒deadline、status<500でWeb upと判定、起動待機120秒/250ms間隔。DTOのengineOk/startedAtはブラウザ再起動検出にも使う |
| restart | controlでbusy/Backend readyを判定して202→stopWeb→settle→build/spawn。Backendがある場合はGoalLoop中でもclient再起動を許可する。旧Backendなし経路だけGoalLoopを照会する。Backend startはidempotent。Web stopでBackend stopしない |

`/api/health`はBackend不在でもWeb生存を200＋engineOk:falseで表す経路がある。`/api/backend/status`はBackend ready/generation診断。両者を一つのreadinessに統合しない。gateway新processのstartedAt/host-probe IDを更新し、Backend PID/generationを変えない。

本番static: API dispatch/拒否をSPA fallbackより先に実施。既知SPA URLのみindex.htmlへ、未知API・private path・存在しないassetはHTMLにしない。traversal/encoded traversal/symlink・MIME/nosniff・HEAD・asset cache・index no-store/revalidation・hash asset immutableを検証。UI asset認証を保ち、indexには秘密・業務snapshotを埋めない。

開発: ブラウザのoriginはgateway（3010等）、gatewayからprivate Vite dev HTTP/HMRへ中継する案。/apiは同じgateway dispatch/auth/Originへ必ず通す。Vite側だけを公開して認証を迂回しない。webProc/dev子の監視・HMR WebSocket・Host loopback proxy・二重originの扱いはPhase3の受入条件。

## 段階別計画・受入条件

| Phase | 変更単位 | 終了gate（次Phase前） |
|---|---|---|
| 0 棚卸し | 本資料・全API対応表・source hash・回帰基準 | 現HEAD/差分/並行確認、165/265と入口閉包一致、Next/routing/SSR/asset/Host契約、リスク/方式/受入条件、限定検証・レビュー・コミット |
| 1 gateway | adapter→auth/edge→全relay→HTTP比較の小区切り | Next依存なし、全165/265＋暗黙method、未知経路拒否。Cookie/Origin/内部headers/generation/deadline/sizeとDTO/status/queryの比較。SSE/abort/stream adapter、owner不在・非再送、業務/SDK非依存 |
| 2 Vite SPA | entry/CSS/assets→routing/Next UI APIs→bootstrap | 全7URL・history/login/callback、設定取得前上書きなし、storage/pane/draft/theme保持。desktop/mobile同viewportで見た目/操作比較。UI/業務改修なし、秘密非露出 |
| 3 配信/Host | 本番dist/cache→dev gateway→Host lifecycle | Vite dev本番禁止、API HTML fallback禁止、asset安全性、readiness DTO/port/bind維持、Web restartでBackend PID/session/lease維持、失敗build復旧とorphans/監視 |
| 4 依存撤去 | browser/gateway value/type gates→旧Next gate置換→manifest/lock/config/test撤去 | BrowserにNode/owner/SDK、gatewayにbusiness/SDK禁止。静的/動的/型import・eval/非literal loader・symlink escape拒否。clean install、Next package/config/import/CLI残存なし、不要互換は利用箇所確認後に限定削除 |
| 5 隔離受入 | 確定HEAD＋対象差分のみTemp、clean install/build/gates→HTTP/UI→実SDK独立性 | 下記全項目と独立レビュー。関連既知失敗を同条件baseline比較し、未受入範囲を明示して限定コミット |

各区切り: ToDo→開始HEAD/差分/担当→関連検証→独立レビュー/必要修正→再検証→限定stage/commit/確認。Pushは明示依頼時のみ。実資格情報・課金生成・稼働サービス変更は別途承認。長時間検証はTemp background launcher＋state/log、shell timeout≤30秒。

### Phase5受入matrix（Phase0では未実行）

1. clean browser/gateway install・production build・型・value/type禁止依存。Browser bundle/HTML/assets/mapsに内部bearer・認証秘密なし。gatewayに業務データやSDK stateが生成されない。
2. HTTP全165route/265操作＋暗黙HEAD/OPTIONS＋未知path/method。URL/method/status/DTO/query/headers/cache、匿名/認証/Origin/peer例外、内部偽header/世代不一致、Backend/Host不在。
3. 主UI: task作成/prompt/cancel/承認/質問/履歴、Bot/Room、設定、pane/tab/draft/bookmark/search。desktop/mobile比較、7直URL/reload/history/login/query/hash/OAuth fixture。
4. SSE全経路の初期snapshot・Last-Event-ID・再接続/多タブ/cleanup。実file streamのfirst byte/backpressure/メモリ/切断、Range/If-Range/HEAD/ETag/cache・gzip profile・TTS・画像。
5. `backend/src/sdk-web-independence{.test,-fixture}.mjs`をgateway entryへ適用し、実SDK＋有限無課金faux providerで受付中gateway停止/再起動。Backend PID/世代/同じsession ID/runtime owner/lease token/acquiredAt・15秒heartbeatを保持。
6. gateway不在中の生成完了、再起動後履歴2結果、SSE再接続、provider call count・各assistant結果/receipt一回、受付済UUID再要求409・非再実行。生成とgateway待機のabortを分離。

API比較fixtureはside effectを各ownerのTempへ隔離し、command受付のUUID/動的時刻をnormalizeする場合は比較規則を記録する。認証401/不在503だけの全route走査で成功DTOの比較を済ませない。実provider/engine・無期限稼働・全Web suiteの成功保証とはしない。

## 回帰基準と証拠の区別

### 引き継ぐ証拠（今回の新規実行ではない）

- Backend分離Phase5 / 受入commit551c494e: 全入口312/165/583/649、clean Web SDK/provider/SQLiteなし、実SDK＋finite faux providerによるNext停止/再起動/SSE/履歴/receipt。
- 独立再検証HEAD5c7643c: 関連native105件・Web104件成功。実provider・全Web suite・無期限稼働は対象外。
- 既知失敗: ConversationLayout scroll follow（500 vs 1200）、image HTTP envelope（undefined vs 404）、store daily snapshot1＋harness-routing12、Windows forks IPC。根拠と条件は`next-thin-phase5.md`。無関係修正せず、新失敗は同HEAD/同条件baselineへ比較する。SettingsView localhost通信拒否ログも隠さない。

### Phase0の新規検証

- `node scripts/check-api-ownership.mjs`: 165/265、欠落/重複/unownedなし。
- `node scripts/check-next-entry-boundary.mjs`: 312/165/583/649、startup2。
- 新inventory script/test、既存境界・Host配信/認証、関連Web認証/Origin/設定/hydrate/navigation/stream testsを実行し、下記に結果を記録する。
- 本Phaseでclean install/full build・実SDK停止fixture・実ブラウザ画像比較は再実行しない。新runtime未実装のため不要。後続Phaseの受入に置き換えたり、今回の結果と混同しない。

検証結果（2026-10-10、HEAD5c7643c＋本Phase0の4ファイルだけをTempへ展開）:

- native（レビュー修正後再実行）: **140成功・0失敗・1skip（WindowsのPOSIX permission試験）**、141件中。新inventory7件、旧API ownership/全入口/UI/transport/startup gate、Host web-plan/auth/loopback/orphan/mirror回帰。
- Web: **15files / 104tests成功**。proxy、auth Cookie/Host Cookie変更、host-probe、shared auth/Origin、setting-sync、server snapshot、LoginForm、AppShell、TaskPanesContext、live/provider SSE、TTS relay。threads / minWorkers1 / maxWorkers2。
- inventory source照合・全route暗黙methodとinstalled Next実装比較、Node syntax、対象diff whitespace、UTF-8無BOM/LF byte round-trip、PowerShell encoding checker/corpus PASS。
- 初回nativeは138成功・1失敗・1skip。原因: `git archive`展開の旧`next-thin-phase0.md`がCRLFで、旧ownershipテストが生成LF表を文字列比較する。新差分に依存しない旧9件だけで同じ1失敗を再現した。LF正規化後のbytesがcheckoutと一致することを検査し、**Temp内の当該Markdownだけ**改行を揃えた。旧9件すべて成功、native全体再実行成功。repoの既存実装/資料は変更しない。初回失敗を成功へ読み替えない。
- 独立したレビュー工程でsource/契約/受入条件を再照合。AST import文字列もLFへ正規化し、inline type re-export分類とCRLF不変回帰を補強。BackendありではGoalLoop中でもWeb再起動可能な現行Host説明を訂正した。別セッションのread-onlyレビュー依頼は応答timeout後に取り消したため、外部レビュー済みとは主張しない。
- 状態/失敗を含むlog: `%TEMP%/leafcode-vite-phase0-validation/state.json`、`native.log`、`baseline-crlf.log`、`baseline-lf.log`、`native-lf.log`、`web.log`、`inventory.log`、`review-state.json`、`review-native.log`。background launcherで完走。installed依存は既存node_modulesをTemp junctionで再利用した**非clean install**検証であり、Phase5のclean受入ではない。

## 再見積もり

Phase0後の残工数目安は**20〜31h、バッファ込み28〜40h**。Phase1 5〜8h、Phase2 5〜8h、Phase3 2〜3h、Phase4 1〜2h、Phase5 7〜10h。独立Backend分離済みで業務移管は不要だが、全APIのsuccess/failure比較、94暗黙HEAD/164 OPTIONS、bootstrap順序、Host dev fallback、SSE adapterが下振れを妨げる。速度改善の実測やUI作り直しを含めない。Phase1 adapter比較後に再見積もりする。
