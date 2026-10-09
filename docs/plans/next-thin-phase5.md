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

## 残る作業

- 画面で使うclient-safe helper/型と、Backend業務実装への互換re-exportを分離。実行グラフに残るBackend/SDK依存を特定して撤去し、旧helperの直接呼出しも整理する。
- API/Proxy/画面の本番value import graph全体への禁止import検査を追加し、ブラウザ認証・入口制限・opaque transportだけを残す。テスト専用のBackend owner検証を本番グラフへ混ぜない。
- Web manifest/lockfile/build mirrorから不要SDK/provider/SQLite等を除去。残存client import/型依存・テスト依存を調べずにpackageだけ削除しない。
- 隔離した実Backend/実Nextで、生成実行中のWeb停止/再起動、Backend PID/世代/SDK session/lease継続、再接続後の履歴・完了結果・受付済operationの非再実行を確認する。register関数だけの子プロセス試験は、この最終受入の代用にしない。

実資格情報・課金生成・稼働サービスの停止/再起動は検証に使わない。他セッションのharness/GoalLoop/provider-overload差分を混ぜない。
