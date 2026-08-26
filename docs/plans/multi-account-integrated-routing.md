# マルチアカウント統合ルーティング 実装計画

## 目的

OpenAI Codex / Anthropic の複数アカウントを、モデル選択上は仮想的な 1 プロバイダーとして扱う「統合モード」を追加する。新規タスクまたは統合モデルへの切替時に、同じモデルを利用できるアカウントのうち利用率が低いものを選び、以後そのタスクを具体的なアカウントへ固定する。

プロバイダーごとに、設定 → モデル → プロバイダー項目から次のモードを変更できるようにする。

- **統合**: アカウント名をモデル候補へ出さず、利用率を基準に自動ルーティングする
- **アカウント別**: 現行どおりアカウントごとのモデル候補を表示し、ユーザーが明示選択する

OpenAI Codex と Anthropic は独立してモードを保持する。既定値は後方互換のため `アカウント別` とする。

前提となる既存仕様は [`multi-account.md`](./multi-account.md) と [`codexbar-multi-account.md`](./codexbar-multi-account.md) を参照する。本計画は認証・利用量の分離を維持したまま、モデル選択と実行解決だけに統合レイヤーを加える。

## 完了条件

- 2 件以上の同一プロバイダーアカウントがある統合モードで、Home / TaskView のモデル候補がプロバイダー × モデルごとに 1 件になる
- 同じモデルを利用できるアカウント A=20%、B=80% なら、新規タスクは A の `accountId` で作成される
- 実際に選ばれた `accountId` はタスクへ保存され、既存セッション・再開・サブエージェントは途中で別アカウントへ移らない
- アカウント別モードへ戻すと、現在のアカウント別候補・有効設定・モデル順が復元される
- プロバイダーごとのモード変更は `ProviderAuthPanel` の当該プロバイダー項目から行える
- 利用量取得失敗、古いキャッシュ、上限到達、モデル差異、未ログインを安全に扱い、別アカウントの認証へ暗黙フォールバックしない
- 既存タスク、非アカウントプロバイダー、既定 auth、CodexBar の親平均表示を変更しない

## 対象と非対象

### 対象

- `openai-codex` / `anthropic` のプロバイダー別モード設定
- `/api/models` の統合モデル候補
- 新規タスク、アイドル中のモデル切替、コンテキストを持たない直接生成のアカウント解決
- CodexBar のアカウント別キャッシュを使った決定的な候補順位
- 選択された具体的アカウントへのタスク固定

### 非対象

- 応答ターンごと、ストリーミング途中、ツール実行後のアカウント切替
- プロバイダーをまたぐ自動フォールバック
- 将来消費トークンの予測や quota の加重推定
- 既定 `~/.pi/agent/auth.json` を統合プールへ混ぜること
- 429 後に会話ターンを自動再送すること

途中切替や自動再送は、重複応答・ツール副作用・監査不能を招くため初期実装に含めない。

## 現状の接続点

- アカウント台帳と認証パス: `web/src/lib/accounts.ts`
- アカウント別 runtime: `web/src/lib/pi/account-runtime-manager.ts` と `getRuntimeFor(accountId)`
- モデル候補の source of truth: `listModelsForAccounts()` → `GET /api/models`
- タスク作成と固定先: `createTask()` / `TaskSummary.accountId`
- タスクモデル切替: `setTaskModel()`
- 使用量: `getCachedUsage()` の `CodexBarProvider`（`accountId`、`usedPercent`、`stale`、`maxed`、`resetsAt`）
- モード UI の配置先: `ProviderAuthPanel` の OpenAI Codex / Anthropic 親項目
- アカウント別 provider/model 有効設定: `provider-model-state.json`

現行 `completeModelText()` は呼び出し側が渡す `accountId` を型・runtime 解決へ反映していない。統合ルーティングを直接生成へ接続する前に、この経路を修正してテストで固定する。

## レビュー・デバッグ結果（実装前に解消する事項）

現行コードを実際の呼び出し経路まで追った結果、次を実装条件として追加する。

1. **タスク作成順序**: 現在の `createTask()` は `insertTask()` の後に `resolveModel()` を呼ぶため、モデル解決失敗時に未接続タスクが残り得る。統合モードでは `resolveConcreteModel()` を insert 前に実行し、失敗時は task を作らない。既存の task 作成テストにこの回帰を追加する。
2. **キャッシュ期限の混同**: `web/src/app/api/models/route.ts` は表示用に最大 30 分の CodexBar cache を読む一方、`web/src/lib/codexbar/cache.ts` の標準 TTL は 5 分である。表示用の `ModelOption.codexbar*` をルーティング判断へ流用せず、実行時は `getCachedUsage()` の標準 5 分 TTL と `provider.accountId` を使う。`provider.stale` は上流取得失敗による last-good 表示であり、外側 cache の経過時間とは別物として扱う。
3. **直接生成のアカウント漏れ**: `direct-title`、task の next-action / permission advice は task の `accountId` を渡すが、project の next-task と git commit-message は context-free である。さらに task account を OpenRouter 等の共有 provider にそのまま渡すと、アカウント runtime に共有モデルが無く失敗し得る。解決関数は `accountId` を対象 provider がそのアカウントに属する場合だけ使い、それ以外は default runtime（統合対象 provider なら自動 route）を使う。
4. **生成モデル設定のアカウント情報消失**: `GenerationModelSettings` は account-prefixed の `ModelOption.value` を選べるが、`settings/[key]` の `splitGenerationModel()` は `providerID::modelID` へ正規化するため、`accountId::providerID::modelID` を保存できない。共有 parser を account prefix 対応にし、先頭セグメントが実在する account の場合だけ `accountId::providerID::modelID` と解釈する（モデル ID 内の `::` を壊さない）。legacy の 2 セグメント値を維持しつつ、生成モデルと fallback の実行時に optional `accountId` を渡す。未知・削除済み account は実行前に再検証し、暗黙に別 account へ変換しない。
5. **Agent 設定の境界**: `AgentsSettings` / `lib/agents.ts` は選択値を `provider/model` に変換し、accountId を保持しない。初期実装では agent の明示的な別 account pin を追加しない。Agent は親 task の concrete runtime/model を継承し、統合モデルの論理 provider/model だけを選択可能にする。アカウント別モデルを Agent 設定へ保存する機能は、subagent extension が runtime account context を受け取れる設計を先に確定してから別スコープにする。
6. **同時作成**: 使用率読み取りと task insert の間には競合がある。provider/model 単位の in-process route lock 内で「候補再構築 → account 選択 → task insert」を直列化し、同率時の working task 数を同時作成にも反映する。ネットワーク呼び出し後の再送や分散ロックは初期実装に追加しない。

## 採用する動作

### 1. モードの単位

```ts
type AccountRoutingMode = "integrated" | "separate";
```

- 設定単位は canonical provider ID
- 対象は `openai-codex` / `anthropic` のみ
- 設定が無い、壊れている、未知値の場合は `separate`
- モード変更は新規タスクと次回のモデル切替・直接生成から有効
- 既存タスクの `accountId` と live session は変更しない

### 2. 統合モードの見え方

統合するのは利用側のモデルカタログであり、管理画面の物理アカウント行は残す。

- Home / TaskView / 生成モデル候補: `OpenAI Codex · 仕事用` 等を出さず、`openai-codex` のモデルを 1 組だけ表示
- `ProviderModelsPanel`: 現行のアカウント別行を維持。各行の provider/model 有効状態が統合プールへの参加条件になる
- TaskView: 実行後は既存 `TaskAccountBadge` で実際に選ばれたアカウント名を表示
- CodexBar: 現行どおり親は平均、展開内はアカウント別。統合モードでも表示集計は変更しない

これにより、仮想プロバイダーのための重複した enable/order ストアを新設せず、既存のアカウント別設定をそのまま候補フィルターとして再利用する。

### 3. 統合モデルの組み立て

同一 provider の有効なアカウントモデルを `modelID` でまとめる。

```ts
ModelOption & {
  routingMode?: "integrated";
  routingCandidateCount?: number;
}
```

内部処理だけがモデルごとの候補 `accountId[]` を保持し、API から受け取った候補 ID は実行判断に使わない。実行時は必ず台帳・認証・モデル状態を再評価する。

統合規則:

1. 候補は登録済み、当該 provider に紐づく、認証済み、provider/model が有効、runtime にモデルが存在するアカウントだけ
2. モデル集合は候補アカウントの **和集合**。一部アカウントだけが持つモデルも、そのアカウントへ限定してルーティングできる
3. ラベルは既存アカウント順で最初の候補から採用
4. `input` と `thinkingLevels` は候補間の共通部分、`reasoning` は全候補で対応するときだけ true とする
5. provider の表示位置は、統合前のアカウント行で最も上にある位置
6. モデル順は `(アカウント行順位, そのアカウント内モデル順位)` の最小値で決め、同順位は `modelID` で安定化
7. アカウント別モードでは現在の account-prefixed value をそのまま返す
8. 統合モードの value は既存の単純形 `providerID::modelID` を使い、仮想 provider ID や新しい区切り形式を増やさない

### 4. ルーティング候補の順位

利用率は CodexBar がすでに計算する代表値を再利用する。代表値は上限へ算入される各 window と credits の最大使用率であり、新しい quota 推定は行わない。

タスク作成時にネットワークで利用量を取得せず、`getCachedUsage()` の通常 5 分キャッシュだけを読む。キャッシュが無くてもタスク作成は可能にする。

候補を次の tier で並べる。

| tier | 状態 | 順位 |
| --- | --- | --- |
| 0 | fresh、使用率既知、`maxed=false` | `usedPercent` 昇順 |
| 1 | stale、使用率既知、`maxed=false` | `usedPercent` 昇順 |
| 2 | 使用率不明、last-good なし、または stale maxed | 実行中タスク数 → アカウント台帳順 |
| 3 | fresh maxed、reset が未来または不明 | 通常候補から除外 |

追加規則:

- `resetsAt <= now` の maxed 値は失効済みとみなし tier 2 に戻す
- 同一 tier・同一使用率では、その provider で `status=working` のタスクが少ないアカウントを優先
- `resetsAt` が不正な値または不明な maxed は tier 3 とし、全候補 maxed の 429 には reset 時刻を含めない
- 最後は `accounts.json` の順で決定し、結果を決定的にする
- tier 0〜2 が無く、全候補が fresh maxed の場合は 429 と、取得できる場合は最も早い reset 時刻を返す
- 使用量キャッシュが全く無い場合は、実行中タスク数 → 台帳順で選ぶ
- 未ログイン、provider/model 無効、runtime にモデル無しは順位付け前に除外

アクティブ件数は同率時だけ使い、使用率差を任意の重みで上書きしない。

### 5. ルーティングのタイミングと固定

```text
仮想モデル選択
  → 実行時候補を再構築
  → 利用率で具体的 accountId を 1 件選択
  → task.accountId へ保存
  → getRuntimeFor(accountId) で session 作成
  → タスク終了まで固定
```

- `createTask`: provider/model 単位の route lock 内で候補を再構築し、task insert 前に具体的なアカウントを決めて `accountId` を保存する
- `setTaskModel`: 統合モデルなら再選択する。別アカウントになる場合は現行どおり working 中を 409、idle 時だけ session を作り直す
- `ensureLive` / resume: 保存済み `task.accountId` だけを使い、モードや最新使用率で再ルーティングしない
- `completeModelText`: 対象 provider が親 account に属する場合だけ明示 `accountId` を使う。明示 account が無く provider が統合モードなら自動選択し、別モードの context-free 呼出しは従来の default runtime を維持する
- タスク配下の title / NextAction / permission advice / subagent は、対象 provider が親 account に属する場合に限り親 `task.accountId` を優先する。共有 provider や別 provider のモデルまで親 account runtime へ送らない
- コンテキストを持たない NextTask / commit message 等は、統合 provider が設定されていれば呼び出しごとに自動選択する
- Agent のモデルは親セッションの `modelRuntime` で解決し、integrated の論理モデルでも concrete な親 task account を継承する。別 account の agent 設定値は初期実装で受理しない

候補 runtime の初期化またはモデル解決が失敗した場合は、task 作成前に次候補を試す。プロバイダーへ送信した後の 401/429/応答失敗は自動再送せず、通常エラーとして扱う。

## 永続化と API

### 設定ファイル

`dataDir()/provider-routing.json` を追加する。`accounts.json`、`store.json`、認証ファイルへ混在させない。

```json
{
  "version": 1,
  "modes": {
    "openai-codex": "integrated",
    "anthropic": "separate"
  }
}
```

要件:

- UTF-8 without BOM、末尾改行あり
- temp + rename の atomic write
- 同一プロセス内の write queue で read-modify-write を直列化
- 未知 provider / mode は保存時 400、読込時は無視
- ファイル無し・破損時は両 provider とも `separate`

### API

`GET /api/providers` の各対象 provider に次を追加する。

```ts
accountRoutingMode?: AccountRoutingMode;
```

新規エンドポイント:

```text
PATCH /api/providers/:id
{ "accountRoutingMode": "integrated" | "separate" }
```

- 対象外 provider は 400
- mode 変更後に harness の health/model cache を invalidate
- CodexBar usage cache は認証・利用量自体が変わらないため消さない
- レスポンスは保存済み mode のみ。候補アカウントや認証情報を受け取らない

## UI 仕様

### 配置

`ProviderAuthPanel` の OpenAI Codex / Anthropic 親項目内、アカウント管理欄の先頭に配置する。

```text
OpenAI Codex   openai-codex   アカウントで管理

モデルの扱い   [ 統合 ] [ アカウント別 ]
統合: 新規タスクを使用率の低い認証済みアカウントへ自動で割り当てます。
既存タスクのアカウントは変更されません。

ログインアカウント                              アカウントを追加
  仕事用  認証済
  個人用  認証済
```

### 状態

- 初期読込: mode コントロールを disabled、既定値へ一瞬切り替えない
- 保存中: コントロールを disabled、項目へ `aria-busy=true`
- 成功: 即時反映し、モデル一覧再取得用の revision を更新
- 失敗: 以前の mode へ戻し、項目内に `role=alert` でエラー表示
- アカウント 0 件 / 1 件でも mode は保存可能。候補が 1 件ならその 1 件へルーティングする
- login/logout/account 変更中は mode 変更を disabled にする

### レスポンシブ・アクセシビリティ

- 2 択は `fieldset` + native radio を使い、見た目だけ segmented control にする
- `legend` は「モデルの扱い」、各 radio のラベルは「統合」「アカウント別」
- mobile は横幅 100%、sm 以上は内容幅。44px 以上の操作領域を維持
- focus ring は既存 `accent/primary` token、選択は色だけでなく文字・checked state で示す
- success/danger 以外の新色を追加せず、既存 `surface-*`、`border`、`text-muted` を使う
- モード説明は常時表示し、使用量不明時の fallback があることをツールチップだけに隠さない

`ProviderModelsPanel` は物理アカウント行を維持し、説明へ「統合モードでは有効なアカウント行がルーティング候補になります」を追記する。

## データフロー

```text
ProviderAuthPanel
  PATCH /api/providers/:id
    → provider-routing.json
    → model/health cache invalidate

GET /api/models
  → 各 account runtime の有効モデル
  → separate: account-prefixed option
  → integrated: provider/model ごとに merge
  → CodexBar cache から候補別 usage を付加
  → Home / TaskView / GenerationModelSettings

createTask / setTaskModel / completeModelText
  → provider mode を確認
  → 実在する候補を再構築
  → cached usage で rank
  → concrete accountId + runtime + model
  → task は concrete accountId へ固定
```

## 実装フェーズ

各 Phase は変更 → 検証 → ToDo 完了 → 即コミットで閉じる。

### Phase 1: mode ストアと API 契約

対象:

- 新規 `web/src/lib/provider-routing.ts`
- 新規 `web/src/lib/provider-routing.test.ts`
- `web/src/lib/types.ts`
- `web/src/lib/generation-model-key.ts` と設定 route（account-prefixed 値の parse/validation）
- `web/src/lib/pi/harness.ts` の provider DTO 組み立て・cache invalidation wrapper
- 新規 `web/src/app/api/providers/[id]/route.ts`
- routing API / generation setting route の関連 test

作業:

- `AccountRoutingMode`、version 1 ストア、default separate、atomic write、write queue
- `ProviderAuthDto.accountRoutingMode`
- PATCH の provider/mode validation
- 既存 2 セグメント生成モデル値との後方互換を保った account-prefixed parser。保存値を勝手に provider/model へ潰さない

検証:

- ファイル無し、破損、未知値、provider ごとの独立保存、同時 write
- 対象外 provider / 不正 mode の 400
- `npm --prefix web run typecheck`
- 対象 test

コミット案: `マルチアカウント統合モードの設定を追加`

### Phase 2: 純粋な候補集約・順位関数

対象:

- `web/src/lib/provider-routing.ts`
- `web/src/lib/provider-routing.test.ts`
- 必要最小限の共有型

作業:

- モデル候補の union と capability intersection
- fresh / stale / unknown / maxed の tier 判定
- reset 済み maxed、working 数、台帳順の tie-break
- 429 用 earliest reset の算出

検証:

- A=20 / B=80、同率、キャッシュ無し、一部 unknown、一部 stale、全 maxed
- モデルが片方だけにある場合
- provider/model 無効候補が除外される入力
- 純粋関数に auth path/token が入らないこと

コミット案: `統合アカウントの候補順位を実装`

### Phase 3: 仮想モデルカタログと利用量表示

対象:

- `web/src/lib/pi/harness.ts` の `listModelsForAccounts`
- `web/src/lib/provider-models.ts`
- `web/src/app/api/models/route.ts`
- `web/src/app/api/models/map.ts`
- `web/src/lib/types.ts`
- 関連 test

作業:

- provider mode ごとに separate / integrated を組み立てる
- 仮想 option は `providerID::modelID`、public metadata は mode と候補数だけ
- 内部 candidate IDs から、実際に次に選ばれる候補の usage をモデル色へ反映
- `codexbarMaxed=true` は全候補が fresh maxed の場合だけ
- 統合 provider/model の順序を既存 account/provider/model order から導出

検証:

- 同一モデルが 1 option になること
- provider ごとに別 mode を混在できること
- 候補ごとの model 差異・disabled が反映されること
- virtual option に account label が付かないこと
- account mode の既存 API snapshot が不変であること

コミット案: `アカウントモデルを仮想プロバイダーへ統合`

### Phase 4: 実行時ルーティングとタスク固定

対象:

- `web/src/lib/pi/harness.ts`
- `web/src/lib/direct-generation.ts`
- `web/src/lib/direct-title.ts`
- `web/src/lib/pi/harness-runtime.test.ts`
- `web/src/lib/pi/harness-complete.test.ts`
- `web/src/lib/direct-generation.test.ts`
- `web/src/app/api/tasks/[id]/next-action/route.ts`
- `web/src/app/api/tasks/[id]/permission/advice/route.ts`
- `web/src/app/api/projects/[id]/next-task/route.ts`
- `web/src/app/api/git/commit-message/route.ts`
- 上記 direct route の関連 test
- task model route の関連 test

作業:

- concrete route（`accountId` + runtime + model）を返す共通解決関数を追加
- `createTask` は provider/model 単位の route lock 内で候補再構築・route・insert を行い、実 accountId を保存。解決失敗時に orphan task を残さない
- `setTaskModel` は integrated option を route し、idle のみ account 切替
- `completeModelText` に `accountId` を正式追加し、明示 account または integrated route の runtime を使う
- resume / ensureLive は保存済み accountId のみを使う
- runtime/model 初期化失敗時だけ次候補へ進む

検証:

- 低使用率アカウントが task と session runtime に一致すること
- explicit account が自動 route より優先されること
- mode separate が現行挙動を維持すること
- mode 変更後も既存 task の resume 先が変わらないこと
- working 中の account 切替が 409
- 全 fresh maxed が 429、cache 無しでも deterministic に選べること
- context-bound 直接生成が対象 provider のときだけ task account、共有 provider は default runtime、context-free 生成は integrated route を使うこと
- `accountId` を task から受け取っても、対象 provider がその account に属さない場合に account runtime を選ばないこと
- 生成モデル設定の account-prefixed 値が再読込後も保持され、削除済み account は候補から安全に除外されること
- Agent の explicit account 値が保存・実行へ混入せず、親 task の runtime を継承すること

コミット案: `タスク実行を低使用率アカウントへルーティング`

### Phase 5: provider 項目のモード UI

対象:

- `web/src/components/settings/ProviderAuthPanel.tsx`
- `web/src/components/settings/ProviderAuthPanel.test.tsx`
- `web/src/components/settings/SettingsView.tsx`
- `web/src/components/settings/ProviderModelsPanel.tsx`
- `web/src/components/settings/GenerationModelSettings.tsx`
- `web/src/components/settings/AgentsSettings.tsx`
- `web/src/components/home/HomeView.tsx`
- `web/src/lib/generation-model-key.ts`
- `web/src/lib/agents.ts`（親 task runtime 継承の validation のみ）
- 必要な選択保持 test

作業:

- provider 項目へ accessible segmented radio を追加
- optimistic 表示ではなく、保存成功後に mode を確定
- Settings 内の生成モデル候補を revision で再取得（`SettingsView` が revision を増やして `ProviderModelsPanel` / `GenerationModelSettings` を再読込する）
- mode 切替後、同じ provider/model があれば Home と生成モデル設定の選択を可能な限り維持。account-prefixed 値は prefix を保持して保存し、integrated 値との変換は既知 account に限定する。Home は次回 refresh 時に同じ論理 provider/model を復元する
- Agent 設定では integrated の論理モデルを保存し、account-prefixed 値は保存せず親 task account 継承に限定する。separate モードの account-prefixed 候補は Agent picker から除外し、未設定（親モデル継承）を維持する
- ProviderModelsPanel の候補説明を追加

検証:

- Codex / Anthropic のみ表示、両者を別 mode にできること
- loading / saving / error rollback
- mobile 幅、keyboard radio 操作、focus、44px hit target、screen reader label
- mode 切替後に重複 account group が統合・復元されること

コミット案: `プロバイダー項目に統合モード切替を追加`

### Phase 6: 統合回帰・手動確認

自動検証:

- `npm --prefix web run typecheck`
- `npm --prefix web test`
- `npm --prefix host test`
- `npm test`
- `npm --prefix web run lint`（既存 warning と新規 error を区別）
- 必要なら production build 前にポート 3010 のトレイホストを停止し、完了後に再起動

手動確認:

1. Codex A=20%、B=80% → Home は Codex 1 グループ、作成 task は A
2. A maxed、B unknown → B を選択
3. A/B とも fresh maxed → 429、reset が既知なら時刻も案内
4. usage cache 無し → working 数・台帳順で作成可能
5. A だけが持つモデル → virtual option は A へ route
6. Codex=統合、Anthropic=アカウント別を同時利用
7. mode を切り替えても既存 working/idle task の accountId は変化しない
8. idle task で統合モデルへ変更すると必要時だけ session を再作成
9. account logout/delete/rename 後に候補・ラベル・route が更新される
10. light/dark、mobile、keyboard、screen reader で provider mode control を確認

コミット案: `統合アカウントルーティングの回帰を確認`

## セキュリティ・障害分離

- client の accountId、候補数、候補 ID、使用率を信用せず、実行直前に `accounts.json` と runtime/model state から候補を再構築する
- accountId は台帳照合後にだけ auth path へ変換する
- account scope は既定 Pi auth / CLI auth へフォールバックしない
- ログ・API・エラーへ token、auth path、JWT payload、provider 内部 account ID を出さない
- usage cache は順位のヒントであり認証可否の source of truth にしない
- mode 変更は認証ファイル、アカウント別 enabled/order、既存 task を書き換えない
- 一部アカウントの runtime/usage エラーを他アカウントの cache や候補除外へ波及させない

## リスクと対策

| リスク | 対策 |
| --- | --- |
| CodexBar cache が古く、実際の空きとずれる | fresh を優先、stale/unknown tier を分離。ルーティング時にネットワーク取得しない |
| 同時作成が同じ低使用率アカウントへ寄る | provider/model 単位の route lock で選択と task insert を直列化し、同率時は working task 数を使う。分散 reservation は実測で必要になってから追加 |
| アカウントごとにモデル catalog が違う | モデル単位の候補集合を保持し、実行直前に runtime.getModel を再確認 |
| mode 切替で既存セッションが移動する | task.accountId を concrete な監査記録として固定し、resume で再ルートしない |
| 全アカウント上限時に失敗を繰り返す | fresh maxed を除外し、全件 maxed は provider 呼び出し前に 429 |
| 自動 retry でツール副作用が重複する | provider 送信後の透過 retry・mid-turn 切替を行わない |
| global 生成モデルに account context が無い | integrated mode だけ自動 route。task context があれば親 account を優先 |
| harness.ts の肥大化 | 永続化・順位・集約は `provider-routing.ts` に置き、harness は runtime 接続だけにする |

## レビューゲート

実装着手前に以下を再確認する。

- virtual provider の境界が `/api/models` と実行解決であり、管理用アカウント行を隠していない
- explicit account > integrated auto route > existing default の優先順位が全入口で同じ
- `/api/models` の表示用 30 分 TTL と、実行時 route の標準 5 分 TTL を混同していない
- task account を共有 provider の runtime に渡さない
- account-prefixed generation value を server 側で 2 セグメントへ潰していない
- task insert より前に concrete account が決まる
- `completeModelText` の account runtime 修正が回帰テスト付き
- 429 / unknown / stale / reset 済みの期待値が純粋関数テストで固定される
- mode 変更が既存 task・auth・provider-model-state を変更しない
- UI が native radio、レスポンシブ、キーボード操作、エラー復元を満たす
