# マルチアカウント対応 実装計画（LeafCodePi 版）

**ゴール:** OpenAI（Codex/ChatGPT）と Anthropic（Claude）のサブスクアカウントを複数登録し、タスクごとに利用アカウントを切り替えられるようにする。既存の API キー・環境変数・default アカウントの運用は変更しない。

**技術:** Next.js（App Router）、React、TypeScript、Vitest（node 環境）。Pi SDK `@earendil-works/pi-coding-agent` の `ModelRuntime.create({ authPath, modelsStorePath })` による認証ストレージ差し替えを利用する。

## 技術的背景

Pi の認証は `~/.pi/agent/auth.json`（プロバイダーID → クレデンシャル1件: `openai-codex` / `anthropic` / `cursor` / `ollama-cloud` / `commandcode` / `openrouter` 等）しか持てない。ただし SDK は:

- `ModelRuntime.create({ credentials?, authPath?, modelsPath?, modelsStore?, allowModelNetwork?, modelRefreshTimeoutMs? })` — `core/model-runtime.d.ts:3-8`。authPath / credentials を差し替えると認証ストレージごと独立したランタイムを作れる
- `AuthStorage`（FileAuthStorageBackend）— ロック付き JSON ファイルストア。`dist/core/auth-storage.d.ts`。書き込み競合に対して安全
- `getAgentDir()` = `~/.pi/agent`（`process.env.PI_CODING_AGENT_DIR` で変更可。`dist/config.js:405` `ENV_AGENT_DIR = "${APP_NAME.toUpperCase()}_CODING_AGENT_DIR"`、420-426）。auth.json は `join(getAgentDir(), "auth.json")`
- `modelsPath`（既定 `~/.pi/agent/models.json`）は**ユーザーのカスタムモデル設定**で全アカウント共有。カタログキャッシュは別物の `modelsStorePath`（既定 `dirname(modelsPath)/models-store.json`、`model-runtime.js:76-80`）

LeafCodePi は `web/src/lib/pi/harness.ts:348` で `ModelRuntime` を**プロセスシングルトン**として共有しており、これが唯一の認証経路:

| 利用箇所 | 行 | 内容 |
| --- | --- | --- |
| `ensureRuntime` | 344-363 | シングルトン生成 + llama/cursor/commandcode/ollama 登録 |
| `createAgentSession` | 1234 | セッションへ `modelRuntime` を渡す |
| `resolveModel` | 1256 | モデル解決 |
| `getHealth` | 1432 | ヘルス |
| `listModels` | 1457 | モデル一覧（キャッシュ） |
| `completeModelText` | 1538 | 直接生成（タイトル等） |
| `listProviderModelsCatalog` | 1575 | プロバイダ別モデル一覧 |
| `listProviderAuth` | 1596 | 認証一覧 |
| `startProviderLogin` | 1627 | ログイン |
| `logoutProvider` | 1684 | ログアウト |

アカウント対応はこの 10 箇所を `getRuntimeFor(accountId)` で解決するよう置換する。default は従来のシングルトンをそのまま返す（後方互換）。

## 対象: Open AI Codex / Anthropic の「サブスク OAuth」

Pi の組み込み OAuth（`openai-codex` / `anthropic`）が対象。Pi の認証フロー自体は「ブラウザで ChatGPT/Claude にログイン」だけでアカウント選択機能を持たないため、**アカウントの切替は WebUI 側で認証ストレージを複数持つことで実現**する。

- 既存 `~/.pi/agent/auth.json` = **default アカウント**（従来どおり）。全既存機能・既存タスクはこのままで動く
- 追加アカウント = `~/.pi/agent/accounts/<accountId>/auth.json`（後述の「認証ファイルの場所」）
- アカウントは「追加の認証レイヤー」。実ファイル・環境変数・default OAuth を奪わない

## 設計

### 認証ファイルの場所（レビュー反映 1）

**`%APPDATA%\leafcode-pi\accounts\<id>`（旧案）ではなく `~/.pi/agent/accounts/<accountId>/auth.json` を使う。**

```text
~/.pi/agent/
├── auth.json                  # default アカウント（従来）
└── accounts/
    └── <accountId>/
        └── auth.json          # 追加アカウントの認証（Pi AuthStorage 形式そのまま）
```

理由:
- Pi CLI は自身の `~/.pi/agent/auth.json`（`PI_CODING_AGENT_DIR` で切替）しか読まないため、WebUI と CLI が別ストアを持つと乖離する。`agent` 配下なら将来の Pi 複数アカウント対応 / `PI_CODING_AGENT_DIR` 切替と整合
- Pi の既定パーミッション（0600）・ロック機構（FileAuthStorageBackend）の管理圏内
- パス解決は `getAgentDir()` + `join` の 1 関数。`%APPDATA%` 経由の OS 依存パスを避ける

**モデル設定とキャッシュの分離（最終レビュー修正）**: `ModelRuntime.create` の `modelsPath` はユーザーのカスタムモデル設定（既定 `~/.pi/agent/models.json`）であり、**触らない**（カスタムモデルは全アカウントで共有）。アカウントごとに分けるのは使い捨てのカタログキャッシュ `modelsStorePath` のみ:

```ts
// アカウント runtime の生成（Phase 6）
await pi.ModelRuntime.create({
  authPath: accountAuthPath(id),                              // accounts/<id>/auth.json
  modelsStorePath: join(accountDir(id), "models-store.json"), // キャッシュだけ分離（再生成可）
  allowModelNetwork: true,
  modelRefreshTimeoutMs: 8_000,
});
```

既定のままだと複数ランタイムが同一 `~/.pi/agent/models-store.json` に競合書き込みするため、キャッシュだけアカウント別にする（FileModelsStore に AuthStorage 相当のロックはない）。

### アカウント定義

```ts
type AccountRecord = {
  id: string;                  // UUID
  label: string;               // 表示名（例: "仕事用 ChatGPT"）
  providers: ("openai-codex" | "anthropic")[];  // このアカウントでログイン可能な provider
  note?: string;
  createdAt: string;
  updatedAt: string;
};
```

- アカウントは「**1 つで複数 provider（OpenAI と Anthropic）をまとめて持てる**」。各 provider の認証状態は別プロパティ（authDir 内の auth.json の provider キー）で判定
- アカウント選択 UI では、フォーカス中のプロバイダ（OpenAI/Anthropic）の認証状態を表示
- `providers` 配列はアカウント作成時に指定。後から変更不可（シンプル化。要れば Phase 後半で追加編集を検討）
- アカウントを増やしても default の `~/.pi/agent/auth.json` は不変（レビュー反映 8）

### アカウントストア

新規 `web/src/lib/accounts.ts`（store.ts と同形式の JSON ファイル永続化。`%APPDATA%\leafcode-pi\store.json` に `accounts: AccountRecord[]` を追加 or 別ファイル `accounts.json`）。

- `listAccounts()` / `getAccount(id)` / `createAccount(input)` / `patchAccount(id, patch)` / `deleteAccount(id)`
- パス解決: `accountAuthPath(id)` = `join(getAgentDir(), "accounts", id, "auth.json")`（Pi の `getAgentDir` に合わせる）
- 実行中セッションの参照管理: `deleteAccount` は「そのアカウントを使う実行中タスクがあるか」を確認し、あれば 409。**ただし履歴タスク（idle/archived）の参照は残してよい**。参照が終わるまで runtime は破棄しない（レビュー反映 4）

### ランタイム多重化（レビュー反映 2・4）

`harness.ts` の `current.modelRuntime` を `Map<accountId, ModelRuntime>` にし、`getRuntimeFor(accountId)` で解決する。

```ts
// 概念
const runtimes = new Map<string, ModelRuntime>();  // accountId → runtime
let defaultRuntime: ModelRuntime | null = null;    // 従来シングルトン

function getRuntimeFor(accountId: string | null): ModelRuntime | null {
  if (!accountId) return defaultRuntime;           // default = 従来挙動（後方互換）
  if (!runtimes.has(accountId)) {
    // 遅延生成。authPath = accountAuthPath(accountId)
  }
  return runtimes.get(accountId) ?? null;
}
```

- **default の既存シングルトンはそのまま**。Phase 2 の間は `getRuntimeFor` は常に default を返し、既存テストが全パスすることを確認してから多重化を入れる
- アカウント runtime は遅延生成し、`ensureOptionalProviders` / `registerLlamaProviders` を default と同様に適用（登録済みでなければ）
- 生成は `allowModelNetwork: true, modelRefreshTimeoutMs: 8000`（default と同一）
- 多重度とメモリ: **優先は「選択中アカウントのキャッシュのみ保持」**。非アクティブ runtime は LRU 的に破棄（上限 2〜3）。ただし実行中タスクが使っている runtime は破棄しない（レビュー反映 2）
- `getHealth` / `listModels` / `completeModelText` / `listProviderModelsCatalog` / セッション生成は、`getRuntimeFor(accountId)`（タスク・クエリ由来）で解決

### モデル一覧とアカウントの連動（レビュー反映 2）

Composer のアカウント選択 = **表示モデル一覧の source of truth** とする。

- Home の Composer で選択された accountId が `GET /api/models` の解決キー
- `current.modelCache` を accountId キーのキャッシュに拡張（default は従来キー）
- アカウント変更時はそのアカウントの runtime を解決して一覧を再取得
- タスク作成 `insertTask` に `accountId` を保存（`web/src/lib/store.ts:136` に追加）。タスク実行時は保存 accountId を使う
- ログイン後の `invalidateHealthCache` は既存機構でアカウントのキャッシュも無効化

### login / logout / 認証一覧（レビュー反映 3）

`setProviderOrModelEnabled` / `saveProviderModelsOrder` はプロバイダ共通設定なので default のまま（アカウントで分けない）。

- `POST /api/providers/[id]/login?accountId=<id>` — ログイン先 runtime を accountId で解決（default は従来通り）
- `POST /api/providers/[id]/logout?accountId=<id>` — ログアウト先も accountId で解決（**logout の accountId 対応を login と同時に実装**）
- 認証一覧も accountId 対応（`GET /api/providers`。`listProviderAuth` を返す既存ルート、`web/src/app/api/providers/route.ts`）
- `ProviderLoginSession` は accountId を保持し（`providerId` と同列）、キャンセル・イベントをアカウント単位で行う

### サブエージェント / 生成モデル / 一時セッション（レビュー反映 5）

- サブエージェント（`leafcode-subagents` の `openai-codex/gpt-5.6-luna` 等）・生成モデル（タイトル/NextAction/NextTask/コミット生成）・一時セッションは**親タスクのアカウントで解決**される（仕様）。親が default なら従来どおり default
- `completeModelText` / `resolveModel` は `getRuntimeFor(taskAccountId)` を使う

### OAuth フローの制約（レビュー反映 7）

- コールバックポート（`localhost:1455` OpenAI Codex / `127.0.0.1:53692` Anthropic）はログインフロー中のみバインドされ、Pi CLI のログインと取り合いになり得る。**同時に 1 アカウントの認証フローのみ**許可し、UI に明示（既存 `startProviderLogin` は 1 セッション制なので流用）
- リモート実行時は既存どおりデバイスコード / 認証 URL 手渡しの代替を許容
- 認証フロー時にブラウザで「どの ChatGPT / Claude アカウントか」を選ぶのはユーザー。UI 文言で注意喚起（例: 「ブラウザでログインするアカウントがこのアカウントと一致することを確認してください」）

### CodexBar 認証経路の統合（Phase 7・任意）

CodexBar（`web/src/lib/codexbar/providers/{openai-codex,anthropic}.ts`）は現在、Pi の auth.json を読まず `~/.codex/auth.json` / `~/.claude/.credentials.json` を独自に参照している。マルチアカウントの仕組みが入った後、Pi の auth.json を読む実装に置換する。

- Pi auth.json の OAuth トークンはそのまま利用量 API（`chatgpt.com/backend-api/wham/usage` / `api.anthropic.com/api/oauth/usage`）の `Bearer` として使える
- リフレッシュは Pi の `refresh` トークンで行い、保存先も Pi auth.json（`FileAuthStorageBackend` 経由）へ
- Pi の auth.json スキーマ（`type/access/refresh/expires/accountId`）依存。**フィールド単位のガードを入れ**、スキーマ変更に耐える（レビュー反映 6）。`readStoredCredential`（`dist/core/auth-storage.d.ts:70`）の利用を検討
- アカウント切替表示は CodexBarWidget に `selectedAccountId` を渡し、対応 provider エントリを表示
- フォールバック: アカウント未登録時は従来どおり `~/.codex` / `~/.claude` を読む（後方互換）

## API / UI 変更点

リスク表の後（「既存機能との関係」）に API・UI の一覧を追加する。

**API（Next.js App Router）**
- `POST /api/accounts` — 作成（label・providers）
- `GET /api/accounts` — 一覧
- `PATCH /api/accounts/[id]` — リネーム・note 変更
- `DELETE /api/accounts/[id]` — 削除。使用中タスクがあれば 409、参照中セッションが終わるまで runtime は保持
- 既存 `POST /api/providers/[id]/login` に `?accountId=`（既定 = 従来挙動）
- 既存 `POST /api/providers/[id]/logout` に `?accountId=`（同上）
- 既存 `GET /api/providers`（認証一覧。`listProviderAuth` を返す、`web/src/app/api/providers/route.ts`）に `?accountId=`（同上）

**UI（設定 → モデル → プロバイダ / Home / TaskView）**
- `ProviderAuthPanel.tsx` に「アカウント」セクション追加: 一覧・作成ダイアログ（label + プロバイダ選択）・「このアカウントでログイン」ボタン（既存 OAuth フロー UI を再利用）・編集・削除
- 各アカウントの provider 認証状態（`openai-codex` / `anthropic`）を Badge 表示
- Home の Composer にアカウント選択（右側にチェックアイコン付きドロップダウン）。選択 = モデル一覧の source of truth
- TaskView ヘッダーに現在のアカウント表示（新規のみ設定可。実行中のタスクでは変更不可）

## 既存機能との関係

- **API キー / 環境変数 / default OAuth / 拡張（subagents・goal-loop・todowrite・permission-gate・collaboration・question）/ llama-server / Ollama Cloud はそのまま**
- CodexBar の利用量表示は CLI の `~/.codex/auth.json` / `~/.claude/.credentials.json` 由来で、Pi の auth.json に依存しないため、アカウント切替と干渉しない（別ブラウザプロファイルではなく「別認証トークン」の概念）。Phase 7 で Pi 統合するまでは現状のまま
- Pi CLI と WebUI のログインは同居可（default の auth.json を共有するだけ）
- Pi メインセッションツール（read/think/powershell 等）・llama-server / Ollama Cloud（API キー）はアカウント外（従来どおり shared）

## フェーズ構成（レビューで改訂・後方互換を先に保つ順序）

各 Phase は「変更 → 検証 → 即コミット」で完結。`next dev` / `next build` / watch 系を実行しない。検証は `npm --prefix web run typecheck` と `npm --prefix web test` に限定。ファイル編集は事前に再読込する。

```text
Phase 1  accounts ストア（model 層・パス解決ユーティリティ + テスト）
   └─ Phase 2  harness に getRuntimeFor(accountId) を追加
        │        （default = 既存シングルトンをそのまま返す。既存テスト全パスを確認）
        ├─ Phase 3  accounts CRUD API + 認証一覧 API（アカウント × provider）
        ├─ Phase 4  login / logout の accountId 対応（OAuth フローは既存 UI を再利用）
        ├─ Phase 5  UI（ProviderAuthPanel アカウントセクション + Composer アカウント選択 → モデル一覧連動 + TaskView 表示）
        ├─ Phase 6  harness 多重化本接続（Map 化 + モデル一覧・生成・一時セッションの accountId 解決）
        │            （Phase 2〜6 の間、default は従来挙動のまま。既存テスト全パス）
        └─ Phase 7  [任意] CodexBar 認証経路の Pi 統合（上記「CodexBar 認証経路の統合」）
   └─ Phase 8  統合・回帰（typecheck + vitest + 手動確認 OAuth を除く）
```

---

### Phase 1: accounts ストア

新規 `web/src/lib/accounts.ts`（model 層）+ `web/src/lib/accounts.test.ts`。

- `AccountRecord` 型、`listAccounts` / `getAccount` / `createAccount` / `patchAccount` / `deleteAccount`
- 永続化: `%APPDATA%\leafcode-pi\store.json` に `accounts` 配列を追加（既存 store スキーマ v1 と共存。読み込み時に欠落していれば `[]` で耐性。既存 `version: 1` のまま配列追加のためマイグレーション不要）
- パス解決: `accountAuthDir(id)` / `accountModelsPath(id)` = `join(getAgentDir(), "accounts", id)` 内。`getAgentDir` は Pi SDK の config から取得（`web/src/lib/pi/config.ts` 等に小さいラッパを新設 or harness 内 util）。default 判定: `id === null || id === undefined` は default、`"default"` という ID は取得しない仕様にする
- `deleteAccount`: 実行中タスク（`status === "working"` 等）が accountId を参照していれば 409（`throw Object.assign(new Error(...), { status: 409 })`）。参照が終わるまで runtime は破棄しない（Phase 6 で実装）

**検証**: `npm --prefix web test -- src/lib/accounts.test.ts`、`npm --prefix web run typecheck`

---

### Phase 2: harness に getRuntimeFor(accountId) を追加

**ファイル**: `web/src/lib/pi/harness.ts`

- `state().modelRuntime` を触る 10 箇所（上表）のうち、まず `getRuntimeFor(accountId)` を新設
- Phase 2 時点では `getRuntimeFor` は常に default を返す（後方互換）。既存テスト全パスを確認
- `resolveModel` / `completeModelText` / `listModels` が「タスク/クエリ由来の accountId」を受け取れるようシグネチャを拡張するのは Phase 6。Phase 2 は関数の追加と、呼び出し経路の整理のみ

**検証**: `npm --prefix web test`（既存全テスト）、`npm --prefix web run typecheck`

---

### Phase 3: accounts CRUD API + 認証一覧 API

**ファイル**: 新規 `web/src/app/api/accounts/route.ts`、新規 `web/src/app/api/accounts/[id]/route.ts`、`web/src/app/api/providers/route.ts`（認証一覧に accountId 対応）

- `GET /api/accounts` / `POST /api/accounts`（バリデーション: label 必須・providers は `openai-codex` / `anthropic` の部分集合・空でない）
- `PATCH /api/accounts/[id]`（label・note。providers は変更不可）
- `DELETE /api/accounts/[id]`（実行中タスク参照時 409。参考: `web/src/lib/store.ts` の既存 deleteTask と同じトランザクション）
- 認証一覧 `GET /api/providers?accountId=`（Phase 6 までは default 互換。アカウント未指定 = 従来どおり）

**検証**: 対象 route test（既存 `providers/route.test.ts` の形式に倣う）、typecheck

---

### Phase 4: login / logout の accountId 対応

**ファイル**: `web/src/lib/pi/auth-login.ts`、`web/src/lib/pi/harness.ts`（startProviderLogin / logoutProvider）、`web/src/app/api/providers/[id]/login/route.ts` / `logout/route.ts`

- `ProviderLoginSession` に `accountId` を保持（コンストラクタ引数追加、デフォルト null）
- `startProviderLogin(providerId, authType, accountId)` — runtime を `getRuntimeFor(accountId)` で解決
- `logoutProvider(providerId, accountId)` — 同様
- API: クエリ `?accountId=` で受ける。イベント SSE も accountId を返す（UI がどのアカウントのフローかを識別）
- **OAuth フローは同時に 1 つ**（既存の 1 セッション制を流用。UI でも明示）

**検証**: `auth-login.test.ts` 拡張（accountId 保持・解決）、`providers/[id]` の既存 route test、typecheck

---

### Phase 5: UI

**ファイル**: `web/src/components/settings/ProviderAuthPanel.tsx`、`web/src/components/home/HomeComposer.tsx`（or 相当）、`web/src/components/task/TaskView.tsx`、`web/src/app/api/models/route.ts`（accountId 対応）

- ProviderAuthPanel: 「アカウント」セクション。一覧（label・各 provider 認証 Badge・ログイン/ログアウト・編集・削除）
- 作成ダイアログ: label 入力 + `openai-codex` / `anthropic` チェックボックス。ログインは既存の `beginLogin`（`?accountId=`）を再利用
- Home Composer: アカウント選択ドロップダウン。選択に応じて `GET /api/models?accountId=` でモデル一覧を再取得（= モデル一覧と連動・レビュー反映 2）。選択は localStorage / 新規タスクに引き継ぎ
- `insertTask` と `patchTask` の Pick 型に `accountId` を追加（`web/src/lib/store.ts:136,171`）、task 一覧・詳細 API も accountId を返す
- TaskView ヘッダー: 現在のアカウント表示（実行中タスクでは変更不可・無効化）

**検証**: 対象 component test（ProviderAuthPanel 相当）、models route test、typecheck。UI の動作は手動確認

---

### Phase 6: harness 多重化本接続

**ファイル**: `web/src/lib/pi/harness.ts`、`web/src/lib/provider-model-state.ts`（キャッシュの accountId 化）

- `state().modelRuntime` を `Map<accountId, ModelRuntime>` + default に拡張。全 10 箇所を `getRuntimeFor(taskAccountId)` へ置換
- アカウント runtime は遅延生成（authPath + modelsStorePath を渡す。「モデル設定とキャッシュの分離」参照）。`ensureOptionalProviders` / `registerLlamaProviders` を適用
- `current.modelCache` を accountId キーのキャッシュへ（default = 従来キー）
- 非アクティブ runtime の LRU 破棄（上限 2〜3、実行中タスク使用は破棄しない）。破棄後は次回 require 時に再生成
- アカウント削除時: 参照中セッションが終わるまで runtime は保持（破棄タイミングは `live` の参照が尽きた時）
- `completeModelText` / `resolveModel` / `listModels` / `getHealth` が accountId を受け取れるようシグネチャ更新（呼び出し元 API ルートで accountId を解決）

**検証**: `npm --prefix web test`（既存 + 新規 harness test）、typecheck。**default の既存テストが全パスすることをこの Phase の完了条件にする**

---

### Phase 7: [任意] CodexBar 認証経路の Pi 統合

**ファイル**: `web/src/lib/codexbar/providers/openai-codex.ts`、`web/src/lib/codexbar/providers/anthropic.ts`、`web/src/components/codexbar/CodexBarWidget.tsx`（selectedAccountId）

- `loadAuth` / `loadCredentials` を Pi auth.json（アカウント別）読みに置換。Pi auth.json スキーマ（`type/access/refresh/expires/accountId`）にフィールドガードを入れ、読めない場合はフォールバック（従来 `~/.codex` / `~/.claude`）へ
- refresh 後は Pi auth.json へ書き戻し（`FileAuthStorageBackend` / `atomicWriteText` の auth 保存に置換）
- CodexBarWidget: タスクの accountId で表示エントリを切替。Pi auth.json に `id_token` / email 情報は無いため `accountEmail` は `null`（email 表示なし）
- **Claude のプラン表示は縮退（最終レビュー修正）**: Pi の auth.json `anthropic` エントリには `subscriptionType` が存在しない（実ファイル確認済み: `[type, refresh, access, expires]`）。プラン非表示、または CLI 認証（`~/.claude/.credentials.json`）が有る場合のみフォールバック表示。Codex のプランは利用量 API 応答 `plan_type` から取得できるため従来どおり表示可

**検証**: codexbar の既存テスト（parse 系は変更なし）+ 新規「Pi auth.json 読み」テスト、typecheck

---

### Phase 8: 統合・回帰

- `npm --prefix web run typecheck`
- `npm --prefix web test`（全 vitest）
- `npm test`（web + host）
- 手動確認リスト:
  1. アカウント作成 → そのアカウントで OpenAI Codex OAuth → モデル一覧がそのアカウントのものに変わる
  2. 2 アカウント作成 → それぞれ異なる ChatGPT/Claude アカウントでログイン → Composer 切替でモデル・利用量が変わる
  3. アカウント未選択（default）で従来どおり動く（既存タスク・API キー・環境変数）
  4. 実行中タスクのアカウント削除が 409 になる
  5. アカウントごとの logout が他アカウント / default に影響しない
  6. リロード後もアカウント選択が維持される
  7. サブエージェント（`leafcode-subagents`）が親タスクのアカウントを使って動く
  8. CodexBar（Phase 7 後）がアカウント単位で利用量を表示する

## リスク表

| リスク | 対応 |
| --- | --- |
| Pi SDK の auth.json スキーマ変更 | フィールドガード + `readStoredCredential` を活用。SDK バージョン固定（package.json のバージョンで管理）。スキーマ変更時は read 層を小さく保つ |
| アカウント数 × モデルキャッシュのメモリ増 | 既定「選択中アカウントのキャッシュのみ保持」+ LRU 破棄（上限 2〜3）。実行中タスク使用は破棄しない |
| 既存セッションへの影響 | Phase 2 で default = 従来シングルトンを保証し、Phase 6 で全置換。既存テスト全パスを各 Phase の完了条件にする |
| OAuth の「どちらのアカウント」はブラウザ次第 | 認証フロー UI に注意文言 + アカウント名を手動登録する設計。フロー中のアカウント誤選択はユーザー操作で戻れる（再ログイン） |
| 同時 OAuth フロー（コールバックポート共有） | 1 アカウント制（既存 startProviderLogin の 1 セッション制を流用）。UI で明示 |
| CodexBar の Pi auth.json 依存（Phase 7） | Pi auth.json を読めない場合は従来 `~/.codex` / `~/.claude` へフォールバック。スキーマ変更はフィールドガードで検知 |
| harness.ts が 2500 行超 | 対象 grep を Phase 1 で確定済み。関数の追加は `getRuntimeFor` 1 本に集約し、呼び出しの置換は Phase 6 に集中 |
| 既存タスクに accountId 無し | 一律 default 扱い（従来挙動と同一）。`insertTask` のみ accountId を追記し、互換性を維持 |

## コミット戦略

| Phase | トピック | コミットメッセージ案 |
| --- | --- | --- |
| 1 | accounts ストア | `マルチアカウント: アカウントストアと認証パスを追加` |
| 2 | getRuntimeFor | `マルチアカウント: ランタイム解決関数を追加（default 互換）` |
| 3 | API | `マルチアカウント: accounts CRUD と認証一覧の accountId 対応` |
| 4 | login/logout | `マルチアカウント: OAuth ログイン・ログアウトの accountId 対応` |
| 5 | UI | `マルチアカウント: 設定・Composer・タスクのアカウント選択 UI` |
| 6 | 多重化 | `マルチアカウント: ランタイム多重化とモデル一覧の accountId 解決` |
| 7 | CodexBar | `マルチアカウント: CodexBar 認証経路を Pi auth に統合` |
| 8 | 回帰 | `マルチアカウント: 全体統合と回帰確認` |

設計文書自体（この docs 追加）は実装開始前に先行コミット済み。