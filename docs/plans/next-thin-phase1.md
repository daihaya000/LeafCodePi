# Phase1：Backendのソース・ビルド独立化

## 対象と責務

受入条件は「BackendがWebソースに依存せずビルド・実行できる」。APIの業務所有者変更・認証変更・DB刷新・巨大harness分割は行わない。

- `backend/runtime-src/lib/`：旧Web実行入口から辿る実行/型依存209モジュールの正本。従来のコードと相対配置を維持。
- `web/src/lib/`：既存importを維持する互換re-export。`types.ts`は既存のshared契約入口を維持。
- `backend/types/`：Backend自身のprovider型宣言。
- `backend/package.json`：runtime依存、esbuild/TypeScript、build/typecheckを直接宣言。
- `backend/tsconfig.runtime.json`：`@/`はBackend runtime-srcへ、core/shared/extension APIは各所有者へ解決。Webのtsconfigを読まない。
- `scripts/build-backend-runtime.mjs`：Backendだけのmanifest/lockfile/installed SDKを検証し、Backendのesbuildで生成。
- WebのTypeScript/Vitestと本番mirrorは、新しい正本への参照を解決する。mirrorにはBackendのソースだけを追加し、Backendプロセスや依存のコピーは混ぜない。

**ソース所有と実行プロセスの所有は別。** 互換入口経由でWebが従来の読取/設定操作を実行する箇所は残る。Phase2以降でHTTP中継へ移す。ブラウザ用の設定cache等、既存グラフに含まれる共有ヘルパーもまず同じ配置へ移し、React/Nextへの依存は導入しない。

開発起動の全面統一は今回の受入条件には含めず、既存`next dev`の互換動作を維持する。独立Backendは`npm --prefix backend run build`後に、既存Hostまたは`npm --prefix backend start`で起動する。内部tokenや稼働中世代は既存Hostが管理し、ソース移動を理由に変更しない。

## ビルド境界

Backend bundleの入力はruntime-src/core/sharedと、使用する2つのextension APIのみ。Webのソース・manifest・lockfile・node_modulesは入力にしない。

- esbuild metafileからWeb入力を検出したら成果物の公開前に失敗させる。
- 変更スタンプはBackendソース/設定/依存と共有契約・使用extension APIを対象にする。Webだけの変更では再ビルドしない。
- Pi SDK/AI/MCPはexternalを維持し、Backend自身の同期済み依存を使用する。
- Command Codeの動的解決はBackendインストールを使用し、`web/node_modules`へのfallbackを撤去する。
- 成果物・sourcemap・stampの公開失敗時の復元は既存動作を維持する。

## 検証

```text
npm --prefix backend run build -- --force
npm --prefix backend run typecheck
npm --prefix web run typecheck
node --test backend/src/source-independence.test.mjs
node --test scripts/build-backend-runtime.test.mjs scripts/build-backend-independence.test.mjs
```

`source-independence.test.mjs`はWebディレクトリもWeb依存もない一時checkoutを構成する。Backendのソース・own node_modules・shared・2つのextension API・ビルドscriptだけで実際にbundleを生成し、別NodeプロセスでBackendを起動する。health ready、内部タスク読取、未認証401まで検証し、子プロセスと一時データを終了/削除する。実ユーザーの資格情報・データは使わない。

追加検査はWeb入力の拒否、Web変更でstamp不変、Backendソース/lock変更でstamp更新、provider/コンパイラー/SQLiteのBackend依存解決を確認する。Webのテストでは互換入口と正本を同一module IDへ解決し、SDK/HTTP/jiti/Markdown依存もdedupeして既存mockの境界を維持する。

### 実測結果

- Backend/core/srcとビルド境界：1,294件成功、失敗0。Webなしfixtureのビルド・health ready・タスクAPI読取・未認証401を含む。
- Host mirror/ビルド関連：71件成功、失敗0。
- Backend/Webのtypecheck成功。Backend強制ビルド成功（6,533 KiB）。
- Web/lib/API：4,978件中4,946成功・30失敗・2スキップ。**全件成功とはしていない。**
- 残る30件は移動前Gitソースを一時展開し、同じ依存とテスト隔離で再実行。store 1件、Bot events 1件、harness-routing 10件、harness-limit-fallback 18件が同じ失敗となり、失敗テスト名の集合一致も検証した。移動前からの問題であり本フェーズでは修正しない。代表的な不一致は旧backup名/旧snapshot形状の期待と、再オープン時に実体session.jsonlを持たないテストfixture。
- 209正本をGitの移動前実装と比較し、改行差を除く実装変更はCommand CodeのBackend依存解決のみ。互換モジュールは従来importを維持する。
