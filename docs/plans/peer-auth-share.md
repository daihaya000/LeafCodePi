# ピア認証共有（pull型）実装計画

**ゴール:** 同一ネットワーク内の別 LCP（利用元 B）が、認証済みの LCP（共有元 A）から Pi プロバイダ認証を pull し、OAuth の refresh 主体を A に一本化したまま利用できるようにする。B の既存 auth（default / 追加アカウント）と既存タスクは壊さない。

**方式:** 秘密配布（pull型）。A が専用トークン付き HTTP API で materialize 済み credential を返し、B は `CredentialStore` 実装経由で利用する。B から A への書込みは行わない。

## 技術的前提（2026-10-03 実測・検証済み）

- 検証対象は `@earendil-works/pi-coding-agent` / `pi-ai` 1.0.0（`web` と `backend` の package.json で exact pin、同一版）。Pi 本体は 1.0.0 で MCP と Codemode を標準搭載した（[記事](https://earendil.com/posts/you-said-no-mcp/)）。本計画は Pi provider 認証（`CredentialStore`）のみを対象とし、SDK 内蔵 MCP の認証には触れない。

- SDK は `CreateModelRuntimeOptions.credentials?: CredentialStore` で認証ストアを差し替えられる（`ModelRuntime.create`）。`SdkRuntimeFactory.createModelRuntime` は options を透過する。
- `resolveProviderAuth` は保存済み credential が最優先（env への暗黙フォールバックなし）。OAuth は残 5 分未満で `credentials.modify` 内で refresh し、ローテーション済み credential を永続化する（`pi-ai/dist/auth/resolve.js`）。
- `readStoredCredential(providerId, authPath)` は SDK ルートから公開 export。A は refresh 後に auth.json から最新 credential を読める。
- OAuth の `toAuth` は `anthropic` / `openai-codex` とも `{ apiKey: access }` のみ。B は `type/access/expires` だけでよく、refresh handler を必要としない。
- プロバイダ認証ルート（`/api/providers`, `/login`, `/logout`）は production でも Web プロセスの harness runtime を使う（セッション所有は Backend 側、`runtime-ownership.ts`）。共有 API は Web 側に置ける。A の Web / Backend は同一 auth.json を `FileAuthStorageBackend` のファイルロックで直列化する（machine 間の競合は B が refresh しないことで回避）。
- アカウント別 runtime の生成点は `web/src/lib/pi/harness.ts` の `accountRuntimeManager`。ここに peer 分岐を追加できる。
- Web の App Router からクライアント IP は取得できない（`proxy.ts` も `x-forwarded-for` を付与しない）。IP 制限は行わず、トークン単位で制限する。
- 既存他セッション WIP（`web/src/lib/pi/setting-validation.ts` 等）と衝突しないよう、settings store は触らず専用ファイルに設定を置く。

## 非対象（v1）

- MCP ネイティブ OAuth（Backend の credential owner / 所有権ゲートと別設計）。SDK 内蔵 MCP は `McpExtensionOptions.credentials?: McpOAuthCredentialStore`（既定 `mcp-auth.json`）を差し替え可能で、将来の v2 候補。ただし LCP は adapter→native の writer 集約移行中（`docs/plans/mcp-native-writer-cutover.md`）のため、完了までは着手しない。`backend/core/mcp-native-*` は別セッションが編集中で、本計画は一切変更しない
- WebUI アクセストークンの共有、双方向同期、B→A 書込み、push 型
- TLS / mTLS（信頼網限定。Tailscale 推奨）
- env / ambient 専用・headers 専用など `Credential` へ materialize できない provider

## 設計

### ワイヤ契約（`shared/peer-auth-*.mjs` + `.d.mts` + tests）

- 認証: `Authorization: Bearer <peer token>`（全エンドポイント）
- `GET /api/peer-auth/list` → `{ providers: [{ providerId, type }], accounts: [{ accountId, label }] }`（秘密なし）
- `POST /api/peer-auth/resolve` `{ providerId, accountId: string | null }`
  → `{ credential: { type: "api_key", key, env? } | { type: "oauth", access, expires } }`
  / 400 / 401 / 403 / 404 / 429 / 503
- 応答は `Cache-Control: no-store`、本文サイズ上限あり

### A 側（共有元）

- 有効化条件: 共有トグル ON かつ `webUiAuthRequired()`。未充足は 409（リモート公開時に WebUI 認証が必須という既存規則に合わせる）
- グラント: ピアごとに `{ id, label, tokenSha256, accountId, providers[], createdAt }`。トークンは 32 byte base64url を生成時に 1 回だけ表示し、保存は hash のみ。失効・削除可
- 保存: `dataDir/peer-auth.json`（グラント・設定）。監査: `dataDir/peer-auth-audit.jsonl`（`at` / `peerId` / `action` / `providerId` / `accountId` / `result` のみ、秘密なし、上限 1000 行）
- 解決手順: `getRuntimeFor(accountId)` → `getAuth(providerId, { minOAuthValidityMs: 10分 })` で必要時に refresh・永続化 → `readStoredCredential(providerId, authPath)`（default は `agentDir/auth.json`、アカウントは `accounts/<id>/auth.json`）で credential を取得。OAuth は `{ type, access, expires }` に削減。API key は保存済み credential を優先し、無ければ `getAuth` の解決値（runtime API key 含む）から `{ type, key, env }` を返す。materialize 不可は 404/409
- 保護: hash 後の timing-safe 比較、トークン単位レート制限（in-memory、既定 60 req/min）、本文サイズ上限、監査記録、CORS ヘッダなし
- ルート構成:
  - `/api/peer-auth/peers`（WebUI 認証。管理 UI 用のグラント CRUD）
  - `/api/peer-auth/list` / `/api/peer-auth/resolve`（peer token。`isPublicWebUiPath` に追加し、ルート内で独自認証）

### B 側（利用元）

- `RemotePeerCredentialStore`（`CredentialStore` 実装）
  - `read`: A へ resolve（メモリキャッシュ。残 6 分未満で再取得、`expires` は A の値を尊重）
  - `modify`: `fn` を実行せず A へ強制再解決（B では絶対に refresh しない）
  - `list`: A の list（キャッシュ）、`delete`: no-op
  - A 不達時は期限内キャッシュを返し、期限切れなら auth エラー
- ピアアカウント: `accounts.json` のスキーマは変更しない。`~/.pi/agent/accounts/<id>/peer.json` の存在で分岐し、`accountRuntimeManager` が `ModelRuntime.create({ credentials: store, modelsStorePath })` を生成（`authPath` なし）
- `peer.json`: `{ version: 1, peerUrl, peerAccountId, providers[], token, createdAt }`（Pi 管理下の agent ディレクトリに保存）。書込みは auth.json と同じ 0o600・原子的置換とし、Windows では既存の Pi credential と同じ user ACL に従う
- アカウント UI: A へ接続テスト → list 取得 → 共有 provider 選択（`AccountProviderId` ∩ A の共有範囲）→ `peer.json` と `accounts.json` を登録。peer アカウントではログイン / ログアウト UI を無効化
- A 停止時: 該当 peer アカウントは認証エラー。UI に「接続元 LCP: オフライン」を表示
- `peer.json` 変更時は当該アカウントの runtime を破棄して再生成する。実行中タスクが参照しているアカウントの変更は 409（既存 `deleteAccount` と同じ規則）

### セキュリティ・規約

- 「remote URL へ鍵を送らない」原則の明示的例外として、本計画と該当コードのコメントに記載
- 平文 HTTP のため LAN / Tailscale の信頼網限定。導入 UI に「トークンと認証情報は暗号化されずに流れる」旨を表示。Tailscale 経由を推奨（既存 loopback-webui-proxy 構成と整合）
- A は read-only 経路のみ提供し、B からの書込み・refresh を許可しない

## 実装フェーズ

1. `shared` のワイヤ schema、A/B の設定ファイル入出力、トークン hash・比較、監査（+ tests）
2. A: 管理ルート・list・resolve、`proxy.ts` の公開パス追加、設定 UI（+ route tests）
3. B: remote store、`accountRuntimeManager` の peer 分岐、アカウント作成 UI（+ tests）
4. 統合: 別 dataDir / agentDir の 2 プロセス（loopback HTTP、実 auth.json）で resolve → remote store → リクエスト認証解決を検証。A 停止・トークン失効・allowlist 外を確認
5. prod build、実機 2 台（Tailscale）で検証、docs 更新

## 実装状況（2026-10-03）

**実装済み（単体・統合テストあり。prod 再ビルドと実機 2 台は未実施）**

- `backend/core/peer-auth-wire.{mjs,d.mts,test.mjs}`: ベアラー解析、resolve 要求の厳格検証、公開 credential の整形（refresh 除去）、list/resolve 応答の検証。Web 側は `@backend-core/peer-auth-wire.mjs` で参照する（prod ビルドは OneDrive 外のミラーで走り、そこでは `backend-core/` と `shared/` が兄弟になるため、相対 import で `shared/` を指す経路は使わない）
- `backend/core/peer-auth-grants.{mjs,d.mts}`: トークン生成（32B base64url）・SHA-256 のみ保存・timing-safe 検証・有効化トグル・作成/失効/一覧・原子的書込み
- `backend/core/peer-auth-audit.{mjs,d.mts}`: JSONL 監査（上限 1000 行、秘密なし）とピア単位の固定窓レート制限
- `backend/core/peer-auth-serve.{mjs,d.mts}`: 認証 → レート → アカウント束縛/allowlist → OAuth は `getAuth(minOAuthValidityMs=10分)` で A 側 refresh 後に再読込 → 公開 credential 化 → 監査。エラーは不透明な 503、全応答 no-store
- `backend/core/peer-auth-remote-store.{mjs,d.mts}`: B 側 CredentialStore（キャッシュ・同時 read 統合・modify で再解決・401/403 はキャッシュ破棄）
- `backend/core/peer-auth-config.{mjs,d.mts}`: peer.json の検証・0o600 での原子的書込み・除去
- `backend/core/peer-auth-integration.test.mjs`: 実 loopback HTTP・実 auth.json での A↔B 検証（refresh 非漏洩・拒否・A 停止）
- `backend/core/peer-auth-sdk.test.mjs`: 実 SDK（`ModelRuntime` ＋ 組み込み anthropic プロバイダ）が peer ストアを受け入れ、残 5 分未満では `modify` 経由で再解決し、ローカル auth.json を読まないことを検証
- Web: `/api/peer-auth/list|resolve`（peer token、公開パスはこの 2 つのみ）と `/api/peer-auth/peers|import`（WebUI 認証下、import は GET で到達性付き peer アカウント一覧）、`lib/peer-auth/{runtime,admin,import,account-runtime-options}`
- harness: `accountRuntimeManager` の peer 分岐（`credentials` で生成、`authPath` なし）。`accounts.ts` の `accountStoredProviders` が peer.json の providers を保存済みとして返す
- UI: A 側 `PeerShareSettings`（共有トグル・アカウント選択・provider 選択・トークン 1 回表示・失効・平文 HTTP 警告）、B 側 `PeerImportSettings`（URL/トークン/名前 → 取込）

**未実施（残）**

- prod 再ビルド・再起動による実表示確認（他セッション作業中のため保留）
- 実機 2 台（Tailscale / LAN）での end-to-end（共有 → 取込 → モデル実行、A 停止・失効の実挙動）
- A 停止時の「接続元 LCP: オフライン」表示（`GET /api/peer-auth/import` の到達性付き一覧を B 側 UI に表示。共有元が停止中はオフラインバッジ）
- peer アカウントのログイン UI 無効化（`auth-status` が `peer` を返し、アカウント行は「別のLCP」バッジを表示してログイン/ログアウトを出さない。サーバー側も 409 拒否）
- peer.json 変更時の runtime 再生成と、実行中タスクがある場合の 409

## 検証

- vitest: schema parse、hash / timing-safe 比較、allowlist、レート制限、監査記録、remote store のキャッシュ・失敗時挙動・refresh 委譲、peer 分岐、route tests（既存 `route.test.ts` パターン）
- `tsc` / eslint の対象実行、`git diff --check`
- 実 HTTP end-to-end（2026-10-03、隔離 dev インスタンス: `next dev --port 3131` ＋ 一時 dataDir/agentDir ＋ `LEAFCODE_PI_WEBUI_AUTH=required`、稼働中の本番ミラーには触れず）: 管理ルートでグラント作成(201)→共有有効化(200)→ peer トークンで list(200・メタデータのみ) → resolve(200・シードした API キー) → 実 `RemotePeerCredentialStore` で取得。トークン無しは 401、監査ログに秘密なしで記録された
- 隔離ミラーでの prod ビルド成功（`✓ Compiled successfully in 44s`・static pages 6/6）
- 実機: A でピア発行 → B へ取込 → B の peer アカウントでモデル実行。A の監査ログ確認。A 停止でエラー、再起動で回復、トークン失効で拒否を確認（未実施）

## リスク・注意

- Codemode の `models.getModelOfType` 等も `ModelRuntime` の認証を使うため、peer アカウントの runtime でもそのまま動く想定（実装時に確認）
- 平文 HTTP（信頼網前提。TLS は v2 以降）
- ローテーション: A の refresh は Web / Backend 間のファイルロックで直列化される既存機構に依存。machine 間は B が refresh しないため競合しない
- peer アカウントの codexbar 利用量表示など、A 固有の付随情報は共有されない（モデル実行は可）。peer アカウントのログイン/ログアウト UI 無効化とオフライン表示は未実装（上記「未実施」）
- 他セッション WIP と分離するため、settings store / `setting-validation.ts` は変更しない
