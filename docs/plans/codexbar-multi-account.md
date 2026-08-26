# CodexBar マルチアカウント利用状況対応 設計計画

## 目的

OpenAI Codex / Anthropic の登録アカウントごとに、CodexBar の利用状況を独立して取得・表示する。既存の `~/.pi/agent/auth.json`、CLI 認証、非アカウントプロバイダーは壊さず、別アカウントのトークン・キャッシュ・エラーが混ざらないことを完了条件とする。

### 完了条件

- アカウント A / B の Codex または Claude の利用量が、同じプロバイダ親行のラベル付き子行として表示される
- 親プロバイダの%は子アカウントの平均使用率とし、A=100%・B=20%なら親は60%になる（最大値100%にはしない）
- A の refresh、401、429、API エラーが B や既定 auth の表示・キャッシュに影響しない
- アカウント登録後の通常表示では、Codex / Claude の既定 auth をアカウント行として表示しない
- アカウント未登録時は現在の既定 Pi auth → CLI auth フォールバックを維持する
- `llama-server`、Cursor、OpenRouter、API キー系などは従来どおりプロセス共通で一度だけ取得する
- API レスポンスとログにトークン、auth path、refresh token、provider 内部アカウント ID を出さない

## 現状と問題

現在の CodexBar 実装は、利用量をプロバイダー単位で取得する。

- `web/src/lib/codexbar/providers/index.ts` の `NATIVE_PROVIDERS` は静的なプロバイダーインスタンス
- `web/src/lib/codexbar/orchestrator.ts` は `provider.id` をキーに 1 回だけ取得する
- `web/src/lib/codexbar/provider-cache.ts` も `openai-codex` / `anthropic` のようなプロバイダー ID だけでキャッシュする
- `openai-codex.ts` / `anthropic.ts` は既定の Pi auth または CLI auth を読むが、`accountAuthPath(accountId)` を受け取らない
- `web/src/lib/codexbar.ts` と `CodexBarWidget.tsx` は `p.id` を表示・React key・折りたたみキーとして使うため、同じプロバイダーを複数行にできない
- `/api/models` の `attachCodexBarUsage` も `providerID` だけで使用量を付けるため、同じプロバイダーのアカウントを区別できない

LeafCodePi 側にはすでに次のアカウント基盤がある。

- 台帳: `web/src/lib/accounts.ts` の `AccountRecord`
- 認証ファイル: `accountAuthPath(accountId, agentDir)` = `~/.pi/agent/accounts/<accountId>/auth.json`
- ランタイム解決: `getRuntimeFor(accountId?)`、`resolvePiAgentDir()`
- 対象プロバイダー: `openai-codex`、`anthropic`

## 採用する表示・認証方針

### 利用スコープ

利用量取得のスコープを次の 3 種類に固定する。

| スコープ | Codex / Claude | その他のプロバイダー | 通常 UI での扱い |
| --- | --- | --- | --- |
| `all` | 登録アカウントごと。該当プロバイダーのアカウントが 1 件も無い場合だけ既定/CLI を 1 行表示 | 既存どおり 1 行 | CodexBar の既定表示 |
| `account` | 指定アカウントの Pi auth のみ | 共有プロバイダーを 1 行 | API / 必要時の絞り込み |
| `default` | 既定 `~/.pi/agent/auth.json` → CLI auth | 既存どおり | 互換・診断用。新しいアカウント UI からは選ばせない |

重要なルール:

- `all` では、あるプロバイダーにアカウントが登録されている場合、既定 auth の同じプロバイダーを混ぜない。既定 auth を誤ってアカウント行として見せないためである
- 例えば Anthropic だけアカウント登録済みなら、Anthropic は登録アカウント行、Codex はアカウント未登録なら既定/CLI の互換行となる
- `account` の `accountId` は必ず `accounts.json` の実在 ID と照合する。任意パスや未登録 ID は受け付けない
- AccountRecord の `providers` に含まれないプロバイダーは、そのアカウントの利用量取得対象にしない
- 既定 auth は既存タスク・既存 API の互換のため保持するが、モデル候補やアカウント管理の対象にはしない

### 認証経路

| 対象 | 読み取り | フォールバック | refresh の保存先 |
| --- | --- | --- | --- |
| 既定スコープ | Pi 既定 auth を優先、無ければ `~/.codex/auth.json` / `~/.claude/.credentials.json` | 現行どおり | 読み取った元のストア |
| アカウントスコープ | `accountAuthPath(accountId, agentDir)` の Pi auth のみ | なし | 同じアカウントの auth.json |
| その他 | 現行の環境変数・共有設定 | 現行どおり | 現行どおり |

アカウントスコープで既定 auth や CLI auth にフォールバックしてはいけない。未ログインのアカウントに別アカウントの使用量を表示することになるためである。

Codex の Pi OAuth credential に含まれる `accountId` は ChatGPT 側のアカウント ID であり、LeafCodePi の `AccountRecord.id` とは別物である。Bearer リクエストの `ChatGPT-Account-Id` ヘッダーには前者が存在する場合だけ使い、レスポンス・ログ・UI には出さない。

## データモデル

### 取得コンテキスト

プロバイダー実装へ渡すコンテキストを追加する。

```ts
type UsageScope = {
  key: string;                 // "default" または "account:<LeafCode accountId>"
  kind: "default" | "account";
  accountId: string | null;    // LeafCode の accountId
  accountLabel: string | null;
  authPath: string | null;     // サーバー内部のみ。APIへ返さない
};
```

`UsageScope` はアカウントごとに生成した provider instance が閉じ込めて保持する。取得中に `PI_CODING_AGENT_DIR`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR` などのプロセス環境変数を切り替えない。アカウント並列取得で認証先が競合するためである。

### 利用量行

既存の provider ID はラベル・アイコン・CodexBar 設定との互換のため変更しない。複数行を区別する `instanceId` とアカウント情報を追加する。

```ts
type CodexBarProvider = ExistingProviderFields & {
  /** Canonical provider id: openai-codex / anthropic / cursor ... */
  id: string;
  /** Unique within one usage response and stable across refreshes. */
  instanceId: string; // default:<providerId> / account:<accountId>:<providerId>
  accountId: string | null;
  accountLabel: string | null;
};
```

- `id` は従来どおり `openai-codex` や `anthropic` とし、同じ provider の親行をまとめるキーに使う
- `instanceId` は React key、アカウント子行の折りたたみ状態、キャッシュ結果の表示単位に使う
- 親行の%と上限件数は、flat な provider 配列から `id` ごとに集約する純粋関数（例: `groupCodexBarProviders`）で計算し、API・モデル候補と同じ account metadata を使う
- `accountId` / `accountLabel` は登録アカウント子行だけに設定し、既定・共有プロバイダーは `null`
- 旧 CodexBar snapshot に追加フィールドが無い場合は `instanceId=default:<id>`、`accountId=null` に正規化する
- API の provider 配列は flat のままでもよいが、UI は `id` で親プロバイダーカードへまとめ、`instanceId` を子行にする
- `codexbar.usage-snapshot/v1` は additive な拡張として維持し、未知の追加フィールドを無視できるようにする。外部の CodexBar ファイル形式を v2 に変更しない

レスポンスには利用量行に加えて、認証情報を含まないアカウント概要を持たせる。

```ts
type CodexBarAccountSummary = {
  id: string;
  label: string;
  providers: Array<"openai-codex" | "anthropic">;
  configuredProviders: Array<"openai-codex" | "anthropic">;
};
```

未ログインアカウントを利用量行として捏造せず、`configuredProviders` と設定 UI の状態で「未ログイン」を表す。

### 集計値

利用率は各アカウントの quota を分母にした比率であり、quota の絶対値が無いまま最大値を親へ引き上げると、片側の上限到達だけで全体が100%に見える。そのため、親プロバイダの表示値を次のように固定する。

- subscription provider（Codex / Claude）の `all` は、利用可能な子アカウントの代表 `usedPercent` の算術平均を `平均 XX%` として表示する。A=100%、B=20%なら60%
- provider API が同一種類の quota 重みを返せるようになった場合だけ加重平均 `Σ(usedPercent × quota) / Σquota` を使う。現行 API は%中心のため、初期実装で勝手にquotaを推定しない
- 未ログイン、last-good の無いエラー、利用率不明の子アカウントは平均の分母から除外する。last-good を表示する子はその値を平均へ含め、stale と明示する
- `default` と単一 `account` の subscription provider は子が1件なので、その値をそのまま表示する。shared provider は従来の provider 値を表示する
- プロバイダをまたぐ「全体%」は quota の意味が異なるため表示しない。折りたたみ時も provider ごとの%、または%を省略した状態件数だけを表示し、`overallUsedPercent` の全体平均を使わない
- `limited` / `maxed` は子アカウントごとに判定する。親は `平均 XX%` と別に `1/2 上限` のような件数を併記できるが、件数だけで親の%を100%にはしない
- `subscriptionTotalMonthlyUsd` は選択スコープに含まれる provider instance の合計であり、アカウント間の重複排除はしない。UI のラベルを「表示中の合計」にする

## バックエンド設計

### Provider factory 化

静的な `IUsageProvider` 1 個を共有するのではなく、次の定義を追加する。

```ts
type UsageProviderDefinition = {
  id: ProviderId;
  name: string;
  scopes: "shared" | "subscription";
  create(scope: UsageScope): IUsageProvider;
};
```

- `openai-codex` / `anthropic` は `subscription`。既定またはアカウントの明示 auth path を閉じ込める
- Cursor、OpenRouter、CommandCode、Ollama Cloud、Synthetic などは `shared`。`default` スコープで 1 個だけ作る
- 既存の `NATIVE_PROVIDERS` は default 用の互換 export として残してもよいが、実際の orchestrator は定義から scope ごとの instance を生成する
- provider instance の `isConfigured()` と `fetch()` は同じ `UsageScope` の認証だけを参照する

### Pi auth 読み書き

対象: `web/src/lib/codexbar/pi-auth.ts`、`providers/openai-codex.ts`、`providers/anthropic.ts`

1. `readPiOAuthTokens` に明示 `authPath` を渡せるようにし、アカウント用では必ずその引数を使う
2. credential の `access`、`refresh`、`expires`、provider 内部 `accountId` をフィールド単位で検証する
3. refresh 書き戻しは `AuthStorage.create(authPath).modify(...)` または `FileAuthStorageBackend` の lock 経由にする
4. 書き戻し時は対象 provider 以外の entry と未知キーを保持する
5. `authPath` が読めない、credential が OAuth でない、access token が無い場合は account scope を未設定として扱う
6. account scope では CLI auth ファイルを参照しない

### Orchestrator

対象: `web/src/lib/codexbar/orchestrator.ts`、`providers/index.ts`、`types.ts`

`fetchNativeUsage` は次の順で動作する。

1. `scope=all` なら `listAccounts()` と enabled provider 設定を読む
2. subscription provider ごとに、登録アカウントがあればそのアカウント群、無ければ default scope を作る
3. shared provider は default scope で 1 個だけ作る
4. account scope の `authPath` を `resolvePiAgentDir()` と `accountAuthPath()` から解決する
5. scope key を含む provider cache を参照して、未キャッシュだけ取得する
6. 結果に `instanceId`、account label、個別 error を付加して組み立てる
7. 一部アカウントが失敗しても、他のアカウントの成功結果は返す

アカウント数が増えたときに Claude の usage API を一斉に叩かないよう、同時 network fetch は 4 件を上限にする。既存の success 5 分、通常 error 2 分、429 15 分の TTL と last-good 表示は scope 単位で維持する。

### キャッシュ

対象: `web/src/lib/codexbar/cache.ts`、`provider-cache.ts`

- provider cache key: `default:<providerId>` または `account:<accountId>:<providerId>`
- aggregate cache key: `scope` と account roster fingerprint（ID・updatedAt・providers）と enabled provider 設定の組み合わせ
- `inflight` も aggregate cache key ごとに分離する
- account A の 429 backoff は account B の key をブロックしない
- account label の変更、account の作成・削除、login/logout、CodexBar provider enablement の変更で該当 aggregate を invalidate する
- アカウント削除後はその provider cache を削除する。認証ファイルを残す既存方針は変更しない
- `/api/models` は利用量を取得せず、該当 scope の aggregate cache だけを読む

## API 設計

対象: `web/src/app/api/codexbar/usage/route.ts`

```text
GET /api/codexbar/usage
GET /api/codexbar/usage?scope=all
GET /api/codexbar/usage?scope=account&accountId=<registered-id>
GET /api/codexbar/usage?scope=default
```

- `scope` 省略は `all`
- `scope=account` は `accountId` 必須。未登録なら 404、形式不正なら 400
- `scope=default` は互換・診断用であり、通常の account selector には出さない
- `refresh=1` は既存どおり aggregate の成功キャッシュを bypass する。ただし provider 単位の 429 backoff は bypass しない
- 一部失敗は 200 で provider 行の `error` に保持する。全 provider が取得不能な場合だけ `available=false`
- API レスポンスには `authPath`、token、ChatGPT account ID、Claude credential の内容を含めない

`CodexBarUsage` の追加フィールド案:

```ts
type CodexBarUsage = ExistingUsageFields & {
  scope: {
    kind: "all" | "default" | "account";
    accountId: string | null;
  };
  accounts: CodexBarAccountSummary[];
};
```

旧 shape を読む `parseCodexBarSnapshot` は追加フィールドを optional として受け、旧スナップショットを引き続き表示できるようにする。

## UI 設計

対象: `web/src/components/codexbar/use-codex-usage.ts`、`CodexBarWidget.tsx`、`web/src/lib/codexbar.ts`

### 表示

- 通常画面のトップレベルはプロバイダー単位にする。トップレベルのアカウント selector は置かない
- Codex / Claude は親プロバイダー行を 1 つ表示し、展開するとその中にアカウント子行を並べる
- 親行は `平均 XX%` を表示し、片方の子が100%でも他の子に余力があれば親を100%にしない

```text
Codex                                      平均 60%  ▼
  仕事用                                  100%
    5時間                                 100%
    週間                                  70%
  個人用                                   20%
    5時間                                  20%
    週間                                  15%

Claude                                     平均 58%  ▼
  仕事用                                   58%
  個人用                                   41%

Cursor                                     18%
```

- 親プロバイダーの使用率は有効な子アカウントの算術平均（quota 重みが取得できる場合は加重平均）、子行は各アカウントの利用枠・リセット時刻・エラーを表示する
- 親行の折りたたみは canonical provider ID、子行の key と個別状態は `instanceId` を使う
- 共通プロバイダーは子行を作らず、従来どおり単一の親行として表示する
- `all` ではアカウント概要を使って未ログインアカウントも Codex/Claude 親行内に「未ログイン」と表示できる。利用量行自体は生成しない。親行生成は利用量配列だけでなく account summary と provider catalog の union を使う
- `scope=account` は API / 将来の絞り込み用に残す。選択時は共通プロバイダー＋対象アカウントの子行だけを返す
- 既定 auth は、アカウント未登録時の `all` で従来どおり表示する。アカウント登録後の通常 `all` では表示しない
- provider enablement の設定は従来どおりグローバルであり、アカウントごとの切替とは別物と明示する

### Hook とローカル状態

`useCodexUsage` は通常 `scope=all` を取得し、必要な場合だけ `scope=account&accountId=...` を取得する。scope 切替時は古いレスポンスを新しい選択へ適用しないため、request generation または AbortController で最新リクエストだけを反映する。

`all` の親行ではプロバイダ間の `overallUsedPercent` を使わず、各 provider group の平均%を表示する。折りたたみチップも複数 provider の平均を作らず、表示可能な provider の%を短縮表示する。

`webui:codexbar:providers` は親プロバイダーの折りたたみを canonical provider ID、アカウント子行の個別状態を `instanceId` で管理する。旧 localStorage の `openai-codex` / `anthropic` キーは親行の状態としてそのまま移行し、アカウント追加後も親行の表示状態を失わない。

### モデル候補への利用量付加

対象: `web/src/app/api/models/map.ts`、`web/src/app/api/models/route.ts`

現在の provider ID だけの一致を、`accountId` を含む型へ変更する。

```ts
T extends { providerID: string; accountId?: string | null }
```

1. account model (`option.accountId` あり) は `providerId + accountId` の利用量行だけを参照する
2. shared model (`option.accountId` なし) は shared provider の利用量行だけを参照する
3. default の Codex/Claude 行は新規モデル候補へ使わない
4. 一致しない場合は利用量フィールドを追加しない

これにより、アカウント A の Codex 使用率がアカウント B のモデル候補へ表示されない。既定 auth の Codex/Claude を新規モデル候補へ戻すことはしない。

## アカウントライフサイクルとの接続

対象: `accounts` API、`harness.ts` の login/logout、CodexBar provider settings API

- account 作成・削除・rename 後に CodexBar の roster/aggregate cache を invalidate する
- account login 成功後は、その account/provider の provider cache と aggregate cache を invalidate する
- account logout 後は、その account/provider の usage 行を次回取得で消す。別アカウントと既定 auth の cache は消さない
- CodexBar の provider enable/disable は provider ID 全体へ適用し、対象アカウントすべての次回取得を invalidate する
- 実行中タスクの account runtime、Pi auth ファイルの削除禁止、OAuth 同時 1 セッションの既存制約は変更しない

## セキュリティ・障害分離

- `accountId` は台帳照合後にだけ path へ変換し、リクエスト値を path traversal に使わない
- account scope が default/CLI path へフォールバックしないことをテストで固定する
- refresh 書き戻しは auth storage の lock 経由にし、login/logout と CodexBar refresh の read-modify-write 競合を防ぐ
- provider cache key に必ず scope を含める。provider ID だけの cache lookup を残さない
- fetch の error message に token、auth path、JWT payload 全体を含めない
- A の失敗は A の行だけに表示し、B の成功結果・last-good snapshot・polling を維持する
- API 401 は対象 scope の refresh を 1 回だけ試し、失敗時は対象行をエラーにする。429 は対象 scope の backoff だけを適用する

## 実装フェーズ

各フェーズは「変更 → 検証 → 即コミット」で完結させる。CodexBar 実 API とブラウザ OAuth は自動テストで置き換え、最後に手動確認する。

### Phase 1: scope / schema / auth path の契約

**対象:**

- `web/src/lib/codexbar/types.ts`
- `web/src/lib/codexbar.ts`
- `web/src/lib/codexbar/export.ts`
- `web/src/lib/codexbar/pi-auth.ts`

**作業:** `UsageScope`、`instanceId`、`accountId`、`accountLabel`、usage scope metadata を追加。旧 snapshot の正規化と explicit auth path の field guard を先に固定する。

**検証:** parse/export、Pi auth の default/account path、旧 shape 互換テスト、typecheck。

### Phase 2: provider の factory 化と Pi auth 対応

**対象:**

- `web/src/lib/codexbar/providers/index.ts`
- `providers/openai-codex.ts`
- `providers/anthropic.ts`
- `web/src/lib/codexbar/types.ts`

**作業:** scope ごとの provider instance を生成。Codex の provider 内部 account ID header、アカウント auth の strict path、lock 付き refresh writeback を接続する。shared provider は default 1 instance のままにする。

**検証:** 2 つの temp auth.json と fetch stub で Authorization/path/header/writeback を分離確認。account scope の CLI fallback が起きないことを確認。

### Phase 3: scoped orchestrator / cache

**対象:**

- `web/src/lib/codexbar/orchestrator.ts`
- `web/src/lib/codexbar/cache.ts`
- `web/src/lib/codexbar/provider-cache.ts`
- `web/src/lib/accounts.ts` 連携部

**作業:** all/account/default の scope 生成、scope cache key、in-flight 分離、bounded concurrency、個別 error/stale 組み立てを実装する。account roster の変更で aggregate を invalidate する。

**検証:** A/B の成功結果が別行になること、A の 429/401/error が B に波及しないこと、同時取得が 4 件を超えないこと、未登録 account を拒否することをテスト。

### Phase 4: usage API と models mapping

**対象:**

- `web/src/app/api/codexbar/usage/route.ts`
- `web/src/app/api/models/map.ts`
- `web/src/app/api/models/route.ts`
- login/logout/account API の cache invalidation

**作業:** scope query、account summary、エラー status、認証情報の非公開を追加。モデルの `accountId` と利用量行を account-aware に対応させる。

**検証:** route の all/account/default、400/404、token 非出力、同一 provider の A/B mapping テスト。

### Phase 5: CodexBar UI

**対象:**

- `web/src/components/codexbar/use-codex-usage.ts`
- `web/src/components/codexbar/CodexBarWidget.tsx`
- `web/src/components/codexbar/CodexBarWidget.test.tsx`
- `use-codex-usage.test.tsx`

**作業:** プロバイダー親行の展開、アカウント子行、account label、未ログイン状態、instanceId key、scope 切替時の stale response 防止、子アカウントの平均%集計、親/子の上限件数表示を追加。

**検証:** 同じ provider の A/B が同じ親行の別子行になること、A=100%・B=20%で親が平均60%になること、親/子の折りたたみ、未ログイン除外、scope filter、refresh、旧 localStorage 移行、keyboard/accessibility を確認。

### Phase 6: 回帰・手動確認

**自動検証:**

- `npm --prefix web run typecheck`
- `npm --prefix web test`
- `npm --prefix host test`
- `npm test`
- `npm --prefix web run lint`（既存 warning と新規 error を区別）

**手動確認:**

1. アカウント A / B を作成し、異なる ChatGPT / Claude OAuth でログインする
2. CodexBar の Codex/Claude 親行を展開すると、A/B の利用量が同じプロバイダー内の別子行になる
3. A=100%・B=20%のとき、親は `平均 60%` であり100%にならない
4. A の利用量が B の子行・モデル候補へ混ざらない（必要なら account scope で A を絞り込む）
5. A の refresh/401/429 と logout が B の子行・親行集計に影響しない
6. account 登録後、通常表示に既定 Codex/Claude が混ざらない
7. アカウント未登録時は既定 Pi auth と CLI fallback が従来どおり動く
8. Cursor、OpenRouter、llama-server 等の共有プロバイダーは重複表示されない
9. provider のグローバル enable/disable が全アカウントへ一貫して反映される
10. アカウント rename 後も usage cache の内容と表示ラベルが一致する
11. 稼働中タスクの runtime と CodexBar の refresh が auth file lock で競合しない

## 非目標

- CodexBar の provider enablement をアカウント単位に分けること（モデル有効/無効設定とは別機能）
- 使用量履歴のデータベース化、日次/月次グラフ、請求額のアカウント間自動按分
- ブラウザプロファイルを自動操作して OAuth アカウントを選ぶこと
- Codex/Claude 以外のプロバイダーをアカウント単位へ複製すること
- 実 API の利用量仕様を推測して provider 内部 ID や plan 情報を新たに公開すること

## 変更予定ファイル一覧

| 領域 | ファイル |
| --- | --- |
| auth / 型 | `web/src/lib/codexbar/pi-auth.ts`、`types.ts`、`codexbar.ts`、`export.ts` |
| provider | `web/src/lib/codexbar/providers/index.ts`、`providers/openai-codex.ts`、`providers/anthropic.ts` |
| fetch / cache | `web/src/lib/codexbar/orchestrator.ts`、`cache.ts`、`provider-cache.ts` |
| API | `web/src/app/api/codexbar/usage/route.ts`、`web/src/app/api/models/map.ts`、`models/route.ts` |
| UI | `web/src/components/codexbar/use-codex-usage.ts`、`CodexBarWidget.tsx` |
| テスト | 上記各 `*.test.ts` / `*.test.tsx` と `web/src/lib/codexbar/providers.test.ts` |

CodexBar の詳細実装は本計画を正とし、アカウント基盤全体の計画は [`multi-account.md`](./multi-account.md) から本書を参照する。
