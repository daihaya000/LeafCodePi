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
- `peer.json`: `{ version: 1, peerUrl, peerAccountId, providers[], token, tokenId, createdAt }`（Pi 管理下の agent ディレクトリに保存）。書込みは auth.json と同じ 0o600・原子的置換とし、Windows では既存の Pi credential と同じ user ACL に従う
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

## 検証

- vitest: schema parse、hash / timing-safe 比較、allowlist、レート制限、監査記録、remote store のキャッシュ・失敗時挙動・refresh 委譲、peer 分岐、route tests（既存 `route.test.ts` パターン）
- `tsc` / eslint の対象実行、`git diff --check`
- 実機: A でピア発行 → B へ取込 → B の peer アカウントでモデル実行。A の監査ログ確認。A 停止でエラー、再起動で回復、トークン失効で拒否を確認

## リスク・注意

- Codemode の `models.getModelOfType` 等も `ModelRuntime` の認証を使うため、peer アカウントの runtime でもそのまま動く想定（実装時に確認）
- 平文 HTTP（信頼網前提。TLS は v2 以降）
- ローテーション: A の refresh は Web / Backend 間のファイルロックで直列化される既存機構に依存。machine 間は B が refresh しないため競合しない
- peer アカウントの codexbar 利用量表示など、A 固有の付随情報は共有されない（モデル実行は可）
- 他セッション WIP と分離するため、settings store / `setting-validation.ts` は変更しない
