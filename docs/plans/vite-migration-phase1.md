# Next → Vite 移行 P1: 独立 Web gateway

## 結果と範囲

P1 の HTTP 入口を実装・隔離検証した。比較基準は P0 完了コミット `07588a00994ab8de8765ae662c822664ab513b4b`。Next は残し、実サービス・Host の起動計画・UI・SDK・業務 owner は変更していない。P2–P5 の SPA 配信やサービス切替は含まない。

- `gateway/src/`: Node HTTP adapter、認証 gate、API dispatcher、独立起動入口。
- `scripts/build-gateway.mjs`: 全 route の manifest 生成、厳格な transport/依存/type 閉包検査、標準 ESM 出力、dist の atomic publication。
- `web/src/app/api/**/route.ts`: 165 route 中 157 ファイルの Next 型/import/Response を標準 Request/Response に置換。残り 8 は元から Next 非依存。既存 relay と業務判断は変更していない。
- `shared/http-cookie.mjs` / `.d.mts`: Next と同じ Cookie 属性・エンコード・置換・読み取り。
- 本番 dependency は既存 Web と同じ `undici@8.10.2` のみ。build は既存 Web の TypeScript / Node 型定義を利用するが、本番出力に Next・SDK・owner は入らない。
- owner guard の既存 transport-only marker `LEAFCODE_PI_PROCESS_ROLE=next` を継続利用する。Next のコードを起動する意味ではない。

## 受入証拠

2026-10-10、Windows / Node v24.16.0 で実測。

| # | 受入条件 | 証拠 |
|---|---|---|
| 1 | 165 API・265 明示操作 | ownership gate、gateway build / manifest、全 route の隔離 HTTP matrix が一致 |
| 2 | 暗黙 HEAD 94 / OPTIONS 164、Allow・405 | manifest 検査、全 route の Next/gateway HTTP 比較、Next auto-implement-methods との比較。HEAD は元の GET handler に HEAD request を渡す挙動も保持 |
| 3 | URL・method・status・DTO・query・headers・Cookie | **917 HTTP 比較成功**。全明示操作、暗黙 method、未対応 method、非公開 route の匿名拒否、Origin 拒否。成功例は settings、task 一覧/受付、Host restart/browser/auth、ファイル Range/HEAD。backend 側に届く origin/host/query/method と Cookie 更新順も確認。末尾スラッシュ・圧縮選択の回帰 11 比較に加え、raw separator redirect と query-only 対照の 43 比較を追加 |
| 4 | 内部 bearer/protocol/generation/deadline/サイズ | owner fixture が内部 bearer と protocol=1 を検査。偽装操作 header を置換。protocol=2 のファイル応答、generation 不一致、health の 1 秒 deadline、TTS 16 KiB 超過を実 HTTP で確認。既存 relay regression は他の制限・guard も検査 |
| 5 | owner 不在で明示失敗、ローカル fallback なし | 初期 matrix は Backend/Host を起動せず、fixture 専用の閉じた port に接続。拒否 DTO/status が Next と一致。gateway data directory は全検証後も未作成。本番閉包に owner がない |
| 6 | 受付済操作の再送なし | 正常受付は frontend 各 1 回。owner が受付後 ACK を切断した場合も各 1 回のみで、503 / execution=unknown を保持。追加の自動再送なし |
| 7 | SSE/file stream/Range/HEAD/切断 | SSE の最初の event を完了前に取得、Last-Event-ID を中継、双方の client abort が owner の close に到達。実 file relay の 200/206/HEAD と bytes を比較。adapter の upload abort、HEAD producer cancel、slow-reader backpressure/drain cleanup を検査 |
| 8 | 本番閉包に Next・SDK・owner なし | runtime 249 modules。strict typecheck と依存 gate 成功。新規 Temp で gateway lock の clean offline install、dependency は undici のみ。Web node_modules junction を除去して gateway を起動。Next/SDK/owner/type import、indirect loader、OS capability、symlink escape の負例を拒否 |

追加の検証:

- `node --test gateway/src/http-adapter.test.mjs gateway/src/auth.test.mjs scripts/build-gateway.test.mjs`: **15/15 成功**。
- adapter test 内で、既存 Next の compression middleware と **347 ケース一致**。wildcard、暗黙 identity、q 値、重複、未知/不正 token を含め、圧縮選択・decoded bytes・Vary・Content-Length を実 HTTP で比較。redirect は GET/HEAD/POST × Cookie 有無、query と Location/Refresh/body/Content-Length、gate/handler 未実行を検査。
- auth test 内で、既存 `web/src/proxy.ts` を参照として **456 ケース一致**。missing token、bearer 優先順、query token 除去、redirect、公開/peer 例外、Cookie parse/serialize を確認。
- 既存 Web の relay / file stream / auth / Host / health regression: **22 files / 180 tests 成功**。生成課金・実認証情報・実データを使わない隔離 env で実行。
- `node --test scripts/inventory-vite-migration.test.mjs`: **7/7 成功**。P0 snapshot を再生成せず、P0 コミットの archive を検査するよう変更。current source の P0 snapshot check が stale になるのは意図した framework 除去による。
- `node scripts/check-next-entry-boundary.mjs`: 312 roots / 165 routes / 584 runtime / 651 type modules、成功。
- `node scripts/check-api-ownership.mjs`: 165 routes / 265 operations、missing/duplicate/unowned なし。
- 全 165 handler を baseline と AST 比較: 変更 157 ファイルは Next 型/import 除去、Response、URL、Cookie helper の置換だけで、正規化した runtime AST が全件一致。

## 比較の前提と非対象

- `scripts/gateway-next-contract.test.mjs` が baseline archive と candidate を Temp に作り、production Next と compiled gateway を loopback の空き port で並行起動する。既存サービスには接続しない。
- Gateway は lock から fresh install。offline は既存 npm cache を利用し、clean-cache install の主張ではない。Next の比較用 dependencies は既存 Web installation から必要 package だけを junction で参照し、新規 clean install の主張ではない。
- Next 側の layout/page は test-only 最小ページ。API の検証であり、SPA/SSR/UI の受入証拠ではない。
- process ごとに違う health startedAt / host-probe UUID、request の checkedAt / operation UUID、Cookie Expires の時計差を正規化する。bind port の差は owner origin/host 比較でのみ正規化。HTTP framing、Date、Connection、Next 固有の診断 header は比較対象外。API の Content-Type/Encoding、cache/security/CORS/Allow/Range/ETag/Cookie、Location/Refresh は比較する。
- `/api/pi/latest-version` の公開 registry metadata GET は有限 fixture に固定する。Node fetch の外部接続を拒否する preload guard を比較プロセスに適用する。
- 成功 DTO は有限 owner fixture の代表例。実 SDK 生成・実 Host restart・実認証情報の移行は実施していない。P1 は transport 契約の受入であり、後続フェーズの業務実行受入ではない。

## 比較で検出・修正した互換差

- Next の `Vary` / streaming JSON compression を保持。RSC 名は cache-key 互換 header だけで、Next/RSC runtime は含まない。SSE は compressor で最初の event を遅延させない。
- handler URL は bind origin を使い loopback を localhost に正規化する旧挙動を維持。browser Host と forwarded defaults は別に保持し、既存 file relay の Host 復元も維持。
- 認証 Cookie refresh は handler Cookie より先に出し、token rotation の最後の Cookie を勝たせる。完全一致する Cookie の重複は除く。

### 独立検証の指摘と修正（2026-10-10）

先の 863 比較は末尾スラッシュと特殊な Accept-Encoding を含まず、独立検証で 4 ケースの不一致が判明した。原因は gateway が canonical redirect より先に認証を評価し、redirect に route の Cookie/Vary を付与していたこと、および圧縮選択が wildcard・暗黙 identity・旧 middleware の gzip 優先を再現していなかったこと。

- 匿名 `/api/tasks/` の 401 を Next と同じ 308 に修正。認証済みでも Cookie/Vary を付けず、Location/Refresh と redirect 本文を保持。redirect は handler をロード・実行しない。
- `Accept-Encoding: *` と `deflate;q=1,gzip;q=0.5` を含む negotiation を旧 middleware と一致させた。新規 runtime dependency は追加していない。Next import は比較用 test のみ。
- 874 HTTP 比較、14 native tests、7 inventory tests、22 files / 180 Web regression tests、build/ownership/entry gates を隔離再実行し、全て成功。内部制限、owner 不在、ACK-loss 非再送、SSE/file/Range/HEAD/切断、独立 install の受入確認を継続。

### raw separator の追加指摘と修正（2026-10-10）

独立検証で `/api//tasks` が Next の認証前 308 と異なり、gateway では匿名 401 / 認証済み 404 になることを確認した。原因は連続 separator の正規化が未実装で、標準 Request に変換する時点で backslash の元情報も失われること。

- adapter から dispatcher へ raw request target を渡し、認証前に連続 slash / backslash を正規化。Next と同じ標準 URL parse の順序で dot segment / query の encoding を扱う。新規 module・runtime dependency・OS capability は追加していない。
- 7 種の raw target × GET/HEAD/POST × Cookie 有無の 42 HTTP 比較を追加。query 内の `//` だけでは redirect しない対照も追加。Location/Refresh/body/Cookie/Vary を比較し、native test は gate/handler の未実行と Content-Length も検査する。
- 917 HTTP 比較、15 native tests、7 inventory tests、22 files / 180 Web regression tests、build/ownership/entry gates が全て成功。165 API / 265 操作、HEAD 94 / OPTIONS 164、runtime 249 modules と全ての既存 guard / stream / 非再送検証を維持。

## 再現手順

```powershell
node scripts/build-gateway.mjs
node scripts/check-api-ownership.mjs
node scripts/check-next-entry-boundary.mjs
node --test gateway/src/http-adapter.test.mjs gateway/src/auth.test.mjs scripts/build-gateway.test.mjs
node --test scripts/inventory-vite-migration.test.mjs
# 約 50 秒。30 秒 shell timeout 内で foreground 起動せず、background launcher とログで監視する。
node --test scripts/gateway-next-contract.test.mjs
```

最新の検証ログ: `%LOCALAPPDATA%/Temp/leafcode-gateway-p1-url-normalization/` の `contract.log` / `state.json`、`web.log` / `web-state.json`。初回の AST 比較などは `%LOCALAPPDATA%/Temp/leafcode-gateway-p1-validation/` の `api-review.json` に保存。独立検証の修正前 4 ケースは `%LOCALAPPDATA%/Temp/leafcode-gateway-independent-verification/extra-cases.json`。連続 slash 修正前の独立検証は `%LOCALAPPDATA%/Temp/leafcode-gateway-p1-independent-final/probes.json`。ログと生成 dist はコミットしない。

運用サービスと別 port の隔離利用では、build 後に gateway 専用 directory で `npm ci --ignore-scripts`、`npm start`。HTTP port は `LEAFCODE_PI_PORT`（既定 3010）、bind は `LEAFCODE_PI_BIND_HOST`（既定 127.0.0.1）。remote bind の browser auth、Backend token/URL/generation、Host control URL は既存 transport env の契約をそのまま使う。実サービスの置換は後続フェーズで明示的に行う。
