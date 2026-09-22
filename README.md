# LeafCodePi

[LeafCode](https://github.com/daihaya000/LeafCode) の UI/UX 構造を維持した、[Pi Coding Agent](https://github.com/earendil-works/pi) 向けの最低限フロントエンドです。OpenCode は使いません。Pi SDK（`@earendil-works/pi-coding-agent`）を Next.js の BFF に埋め込み、ブラウザからセッションを操作します。

## できること（MVP）

- サイドバー: プロジェクト / タスク一覧、折りたたみ、テーマ切替
- ホーム: プロジェクト選択 + composer + モデル / 思考レベル
- タスク: タイムライン（テキスト・思考・ツールカード）+ SSE ストリーミング + 停止 + **コンテキスト使用量**
- 設定: Pi のヘルス、**llama-server 起動**、再起動。**エージェントタブでグローバル AGENTS.md / SOUL.md / USER.md**。モデルタブで **Claude / ChatGPT / Cursor サブスク**、**Ollama Cloud / OrcaRouter**、有効・無効・並び替え、有効モデル一覧
- プロジェクト追加: ホスト PC ではクリック時にエクスプローラー（ネイティブフォルダ選択）を直接開き、選択で即追加。リモートはパス入力 / アプリ内フォルダ一覧

## カスタム指示（AGENTS.md / SOUL.md / USER.md）

設定 → エージェント → 「共通指示」から `~/.pi/agent/AGENTS.md`（作業手順・制約）、`SOUL.md`（Code専用の性格・口調）、`USER.md`（Bot/Code共通のユーザープロフィール）を編集できます（全プロジェクト共通）。保存時に開いているセッションへ即時反映します。プロジェクト単位の AGENTS.md 編集は未対応です。

## ローカル LLM（llama-server）

`start.bat`（Windows）または `./start.sh` / `npm run host`（Linux/macOS）起動後、設定 → エンジン → 「ローカル LLM (llama-server)」から起動・停止できます。

- ポート **8081**（LeafCode の llama-server と同じ。片方を起動すれば共有可）。
- `MODEL_FILE` 未指定 → ルーター（`--models-dir`）でモデルを切り替え。
- `MODEL_FILE` 指定 → 単体 GGUF（`-m`）。プロバイダー ID `llama-server`。
- Windows のバイナリ既定: `C:\tools\llama.cpp\llama-server.exe`
- Linux/macOS: 設定画面でバイナリを指定するか、`LEAFCODE_PI_LLAMA_SERVER_BIN`（未設定時は PATH の `llama-server`）を設定します。モデルディレクトリの既定は `~/models/llm` です。Linux では Vulkan `Vulkan0` を選び、CPU offload を無効にした LeafCodeCloud 相当の起動設定を使います（`LEAFCODE_PI_LLAMA_GPU_DEVICE` で変更、空文字で無効化）。Windows も同じ sampling / KV cache / CPU offload 防止設定を使います。Linux/macOS では host がバイナリを detached process として直接起動します。

## Ollama Cloud

設定 → モデル → Ollama Cloud で API キーを登録するか、環境変数 `OLLAMA_API_KEY` を設定します（[キー発行](https://ollama.com/settings/keys)）。

- エンドポイント: `https://ollama.com/v1`（OpenAI 互換）
- プロバイダー ID: `ollama-cloud`
- モデル一覧はログイン後に `/v1/models` から取得

## OrcaRouter

設定 → モデル → OrcaRouter で API キーを登録するか、環境変数 `ORCAROUTER_API_KEY` を設定します（[キー発行](https://orcarouter.ai)）。

- エンドポイント: `https://api.orcarouter.ai/v1`（OpenAI 互換）
- プロバイダー ID: `orcarouter`
- モデル一覧はログイン後に `/v1/models` から取得
- CodexBar は `/v1/dashboard/billing/subscription` と `/v1/dashboard/billing/usage` から利用額・残高を取得
- モデル ID は `openai/gpt-4o-mini` のようなプロバイダー付き形式です

## サブスクリプション認証

設定 → モデル → 「サブスクでログイン」からブラウザ OAuth できます。

| プロバイダー | 対象サブスク | Pi 上の ID |
| --- | --- | --- |
| Anthropic | Claude Pro / Max | `anthropic`（oauth） |
| OpenAI Codex | ChatGPT Plus / Pro | `openai-codex` |
| Cursor | Cursor サブスク | `cursor`（`@rahularya01/pi-cursor`） |
| Ollama Cloud | API キー | `ollama-cloud` |

Cursor は非公式拡張です。本機の Cursor IDE / CLI のトークンを使うか、設定画面から「サブスクでログイン」します。Node.js **22.19+** を推奨します。

トークンは Windows では `%USERPROFILE%\.pi\agent\auth.json`、Linux/macOS では `~/.pi/agent/auth.json` に保存されます。コールバックは本機の `127.0.0.1:53692`（Anthropic）と `localhost:1455`（OpenAI Codex）を使います。通常の API キー（`ANTHROPIC_API_KEY` など）も併用できます。

リモートマシン上の WebUI を手元のブラウザで開いている場合、IdP はホストの loopback に戻すため、そのままではログインできません。次のいずれかにしてください。

```bash
ssh -N -L 53692:127.0.0.1:53692 -L 1455:127.0.0.1:1455 user@host
```

- 上記の SSH ローカルフォワード（Claude 53692 / Codex 1455）
- API キー
- プロバイダーが出すデバイスコード

同一マシン上のブラウザ、またはホスト上で開いたブラウザならポートフォワードは不要です。コールバック URI 自体は変えません。

## マルチアカウント（ChatGPT / Claude の複数アカウント）

設定 → モデル → 「アカウント」から、ChatGPT (Codex) と Claude のサブスクアカウントを複数登録してタスクごとに切り替えられます（[計画](docs/plans/multi-account.md)）。

- 追加アカウントのトークンは Windows `%USERPROFILE%\.pi\agent\accounts\<accountId>\auth.json`、Linux/macOS `~/.pi/agent/accounts/<accountId>/auth.json` に保存されます（既定の auth.json は不変）
- Home の Composer でアカウントを選ぶと、そのタスクとモデル一覧がそのアカウントに紐づきます。未選択 = 既定
- アカウントが無い場合は選択 UI 自体が非表示になります。OAuth のログインフローは同時に 1 件のみです
- 実行中のタスクから参照されているアカウントは削除できません。認証ファイルは削除後も残ります（手動削除は Windows `%USERPROFILE%\.pi\agent\accounts\`、Linux/macOS `~/.pi/agent/accounts/` 配下）

## 同梱拡張

LeafCodePi には次の Pi 拡張を同梱しています。WebUI と連携する拡張はリポジトリから自動的に読み込まれます。

| 拡張 | 役割 |
| --- | --- |
| `leafcode-goal-loop` | Goal Loop と完走モード |
| `leafcode-intercom` | 並行 Pi セッション間の1対1通信（`intercom`、`/intercom`、Alt+M） |
| `leafcode-memory` | 永続メモリ、セッション検索、手続き型スキル |
| `leafcode-mcp-adapter` | MCP サーバー接続とツール呼び出し |
| `leafcode-permission-gate` | ツール実行の権限ゲート |
| `leafcode-question` | WebUI からの質問応答 |
| `leafcode-subagents` | サブエージェント委譲、エージェント定義、スキル、プロンプト |
| `leafcode-todowrite` | OpenCode 互換の ToDo 管理 |
| `leafcode-tts` | Bot / エージェントの発言の読み上げ（`/tts`・既定 OFF・WebUI 依存のため無効化不可） |
| `leafcode-web-access` | Web 検索、URL/PDF/GitHub/動画の取得・解析 |

ルートの `skills/` と `extensions/*/skills/` 配下にある `SKILL.md` は LeafCodePi の組み込みスキルとして自動検出され、通常の Pi スキルと同じく設定画面から有効／無効を切り替えられます。グローバルディレクトリへのコピーやインストールは不要です。エージェントは `available_skills` の `location` に提示された実パスを読み、相対参照はその `SKILL.md` のディレクトリを基準に解決します。存在しないグローバルパスを指定した場合だけ、有効な一覧から一意に対応するスキルへの `read` を補正し、実パスを結果に明示します。既存ファイルや書き込み先は変更しません。

### Goal Loop

`extensions/leafcode-goal-loop` に LeafCode 互換の Pi 拡張を同梱しています。登録すると Home / Task の Composer に「ループ」「承認条件」「最大ターン」「クールタイム」「完走モード」が表示されます。

```powershell
pi install ./extensions/leafcode-goal-loop
```

通常モードは完了宣言を検証ターンで確認し、完走モードは完了宣言を無視して指定ターン数まで実行します。最大ターンを `0` にすると無制限、クールタイムは `15m 30s` のように指定できます。状態は `%APPDATA%\leafcode-pi\goals-loop\` に保存されます（`LEAFCODE_PI_DATA_DIR` 指定時はその配下）。

ループ実行中も Composer から追加の指示を送信できます。送信は実行中ターンへ差し込み（送信方式「キュー」なら followUp として現在のターンの後）に渡され、ループは止まりません。追加指示はループ状態にも記録され、以降のターンのプロンプトに再掲されるため、長いループで会話履歴が圧縮されても残ります（最大10件・1件500文字、超過分は古い順に破棄、新しいループの開始で消去）。止めたいときは「一時停止」または「停止」を使います。

### ToDo (`todowrite`)

`extensions/leafcode-todowrite` は OpenCode の `todowrite` と
組み込みの [`skills/todowrite-discipline/SKILL.md`](skills/todowrite-discipline/SKILL.md) の形式に合わせた Pi 拡張です。
`pending` / `in_progress` / `completed` / `cancelled`、`high` / `medium` / `low` を扱い、
`in_progress` は同時に1件だけ許可します。Pi セッションの tool result に状態を保存し、
Task 画面には本家 LeafCode と同様の折りたたみ式 ToDo 進捗とプログレスバーを表示します。

起票漏れを防ぐため、`in_progress` を含む non-empty の ToDo を登録する前の変更、shell、委譲、memory変更、未分類toolを停止します。
`git status` / `git diff` を PowerShell / bash で実行する開始時のGit確認も shell に含まれるため、変更タスクでは初回Git確認より先に `todowrite` を呼びます。通常のread-only作業も3回目までに起票が必要です。`AGENTS.md` / `SKILL.md` の確認と制御toolは対象外です。
streaming中の `steer` / `followUp` とextension入力は現在のタスクの継続として扱います。

```powershell
pi install ./extensions/leafcode-todowrite
```

### MCP

`extensions/leafcode-mcp-adapter` に `pi-mcp-adapter` の LeafCodePi 組み込みフォークを同梱しています。

```powershell
pi install ./extensions/leafcode-mcp-adapter
```

設定は `.mcp.json` または `~/.pi/agent/mcp.json` の `mcpServers` に記述します。

### n8n（Instance-level MCP + 公式Skills）

n8n公式の Instance-level MCP サーバーと、n8n公式Skills（[n8n-io/skills](https://github.com/n8n-io/skills)）を組み込みで同梱しています。

**n8n側**: **Settings → Instance-level MCP** で MCP access を有効化します（n8n 2.2.0 以降）。OAuth で接続する場合は追加の準備はありません。APIキーを使う場合は **Connect a client → API key** タブでアクセストークンを生成し、Server URL（`https://<domain>/mcp-server/http`）を控えます（Connect a client は n8n 2.33.0 以降のUI）。

**LeafCodePi側（OAuth・推奨）**: WebUI の **設定 → 拡張 → MCP サーバー** の「n8n を追加（OAuth）」にインスタンスURL（例 `https://example.app.n8n.cloud`）を入れると、`~/.pi/agent/mcp.json` に `auth: "oauth"` のエントリが追加されます（`/mcp-server/http` は自動補完）。続いて **認証設定 → OAuth認証を開始** でブラウザ認証し、コールバックURLまたは認証コードを貼り付けて完了します（n8n側は DCR（RFC 7591）でクライアント登録されます。実機の認証フローはn8nのバージョンで確認してください）。

**LeafCodePi側（APIキー / 手動）**: `.mcp.json` または `~/.pi/agent/mcp.json` に次のエントリを追加します。`url` へ Server URL を直接書いても、`${N8N_MCP_URL}` / `N8N_MCP_ACCESS_TOKEN` の環境変数を使っても構いません。TUI では `/mcp setup` の n8n preset からも追加できます。

```json
{
  "mcpServers": {
    "n8n": {
      "url": "${N8N_MCP_URL}",
      "auth": "bearer",
      "bearerTokenEnv": "N8N_MCP_ACCESS_TOKEN",
      "httpTransport": "streamable-http",
      "protocolVersion": "auto"
    }
  }
}
```

トークンは設定ファイルに直接書かず、WebUI の **設定 → 拡張 → MCP サーバー** の「認証設定」で保存してください（OS の資格情報ストアに保存されます）。

**n8n公式Skills**: `skills/` に14スキル（capability 13 + メタ1）と references を同梱しています。組み込みスキルとして自動検出され、設定画面から有効／無効を切り替えられます。n8n作業時はエージェントが `using-n8n-skills-official` を入口に該当スキルを読みます。取り込み元・更新手順は [`skills/n8n-skills-SOURCE.md`](skills/n8n-skills-SOURCE.md) を参照してください。

### Slack（公式MCP + 公式Skills）

Slack公式の MCP サーバー（`https://mcp.slack.com/mcp`）と、Slack公式Skills（[slackapi/slack-skills-plugin](https://github.com/slackapi/slack-skills-plugin)）を組み込みで同梱しています。SlackはDCR（動的クライアント登録）非対応のため、事前登録したSlackアプリの Client ID を使います（PKCE。client secret は不要）。

**Slack側**: ワークスペース管理者による MCP の承認が必要です（MCP は internal app または directory-published app のみ利用可。自ワークスペース用の internal app で構いません）。

1. [api.slack.com/apps](https://api.slack.com/apps) でアプリを作成し、**OAuth & Permissions** で **PKCE を有効化** します（一方向の操作で戻せません。有効化すると refresh token は30日で失効します）
2. **Redirect URLs** に `http://localhost:19876/callback`（既定。`MCP_OAUTH_CALLBACK_PORT` で変更可）を追加します（PKCE 有効時のみ localhost の http を登録できます）
3. **User Token Scopes** を付与します（例: `search:read.public`・`search:read.private`・`search:read.files`・`chat:write`・`channels:history`・`groups:history`・`canvases:read`・`canvases:write`・`reactions:write`・`files:read`・`files:write`・`users:read.email`・`lists:read`・`lists:write`。ツール別の完全な対応表は [Slack MCP server docs](https://docs.slack.dev/ai/slack-mcp-server/) の「OAuth scopes needed on user token for different tools」参照）
4. **Agents** セクションの **Slack Model Context Protocol (MCP) Server** を **On** にします
5. **App Credentials** の **Client ID** を控えます

**LeafCodePi側**: WebUI の **設定 → 拡張 → MCP サーバー** の「Slack を追加（OAuth）」に Client ID を入れると、`~/.pi/agent/mcp.json` に `oauth.clientId` 付きのエントリが追加されます。続いて **認証設定 → OAuth認証を開始** でブラウザ認証し、コールバックURLまたは認証コードを貼り付けて完了します。手動で設定する場合は次のエントリを追加します。

```json
{
  "mcpServers": {
    "slack": {
      "url": "https://mcp.slack.com/mcp",
      "auth": "oauth",
      "httpTransport": "streamable-http",
      "protocolVersion": "auto",
      "oauth": { "clientId": "<your-slack-app-client-id>" }
    }
  }
}
```

**Slack公式Skills**: `skills/` に8スキル（slack-messaging / slack-search / slack-api / slack-cli / slack-docs / block-kit / create-slack-app / test-slack-app）と references を同梱しています。組み込みスキルとして自動検出され、設定画面から有効／無効を切り替えられます。取り込み元・更新手順は [`skills/slack-skills-SOURCE.md`](skills/slack-skills-SOURCE.md) を参照してください。

**トラブルシューティング**: `Incompatible auth server: does not support dynamic client registration` は `oauth.clientId` の未設定が原因です（SlackはDCR非対応。このフォームで設定済みなら発生しません）。issuer 検証エラーが出る場合は、エントリの `oauth` に `"skipIssuerMetadataValidation": true` を追加してください（Slackの metadata issuer（`https://slack.com`）と MCP URL（`https://mcp.slack.com`）の差異による既知の回避策）。アプリに IP allowlist を設定している場合は、MCP クライアントの接続元 IP を許可リストに含めてください。

### Google Workspace（公式MCP）

Google公式の Google Workspace リモート MCP サーバー（Developer Preview）を組み込みで対応しています。Gmail / Drive / Docs / Sheets / Slides / Calendar / Chat / People の8プロダクトを一括追加します（Streamable HTTP、OAuth 2.0）。GoogleはDCR（動的クライアント登録）非対応のため、事前に作成した OAuth クライアント（Web application）を使います。

**Google Cloud側**:

1. Google Cloud プロジェクトで対象の API と MCP API を有効化します（例: `gmail.googleapis.com` + `gmailmcp.googleapis.com`。手順は [Configure the Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers) 参照）
2. **Google Auth Platform → Branding / Audience / Data Access** で OAuth consent screen を設定し、使うプロダクトのスコープを追加します
3. **Clients → Create client → Web application** で OAuth クライアントを作成し、**Authorized redirect URIs** に `http://localhost:19876/callback`（既定。`MCP_OAUTH_CALLBACK_PORT` で変更可）を追加します
4. **Client ID** と **Client Secret** を控えます

**LeafCodePi側**: WebUI の **設定 → 拡張 → MCP サーバー** の「Google Workspace を追加（OAuth）」に Client ID / Secret を入れると、`~/.pi/agent/mcp.json` に8エントリ（`gws-*`）が追加されます。プロダクトごとに **認証設定 → OAuth認証を開始** でブラウザ認証してください（使うプロダクトのみで構いません）。

**注意**: OAuth クライアントの Client Secret は Slack の Bearer と異なり `~/.pi/agent/mcp.json` に保存されます（アダプターのOAuth仕様）。ファイルの取り扱いに注意してください。

**スコープ**: 既定は各プロダクトの読み取り中心のスコープです（Googleの設定ガイドの推奨セット。`access_type=offline` を付与し refresh token を取得します）。書き込み系ツールを使う場合は、consent screen の **Data Access** と該当エントリの `oauth.scope` に追加スコープ（例: Calendar の `create_event` なら `https://www.googleapis.com/auth/calendar.events`）を追加してください。

**Chat を使う場合**: Google Chat MCP は追加で Chat app の設定が必要です（Google Cloud の Chat API → Configuration。[設定ガイド](https://developers.google.com/workspace/guides/configure-mcp-servers) 参照）。

**トラブルシューティング**: 同意画面でスコープエラーが出る場合は、consent screen の **Data Access** に該当スコープを追加してください。プロダクトごとに認証が必要です（例: Gmail のみ使うなら `gws-gmail` のOAuthだけで構いません）。

### Notion（公式MCP）

Notion公式のホスト型MCPサーバー（`https://mcp.notion.com/mcp`）を組み込みで対応しています。NotionはDCR（RFC 7591）対応のため、URLのみでOAuth接続できます（client IDなどの事前準備は不要。認証はPKCE）。

**Notion側**: ワークスペース所有者が **Settings → Connections** でMCPクライアントのアクセスを管理します（初回認証時に認可）。

**LeafCodePi側**: WebUI の **設定 → 拡張 → MCP サーバー** の「Notion を追加（OAuth）」を押すと、`~/.pi/agent/mcp.json` にエントリが追加され、認証パネルが開きます。**OAuth認証を開始** でブラウザ認証し、コールバックURLまたは認証コードを貼り付けて完了します。TUI では `/mcp setup` の Notion preset からも追加できます。

手動で設定する場合は次のエントリを追加します。

```json
{
  "mcpServers": {
    "notion": {
      "url": "https://mcp.notion.com/mcp",
      "auth": "oauth",
      "protocolVersion": "auto"
    }
  }
}
```

**トラブルシューティング**: 認可が切れた場合（DCRクライアントの失効など）は、認証設定の **OAuth認証を解除** から再認証してください。NotionはAPIキー方式に対応していません（OAuthのみ）。

### Intercom

`extensions/leafcode-intercom` に `pi-intercom` の LeafCodePi 組み込みフォークを同梱しています。`intercom` ツール、`/intercom`、Alt+M で別セッションへ1対1メッセージを送れます。

```powershell
pi install ./extensions/leafcode-intercom
```

設定は Windows `%USERPROFILE%\.pi\agent\intercom\config.json`、Linux/macOS `~/.pi/agent/intercom/config.json` に記述します。`inboundTrigger` は `replies`（既定。保留中の問い合わせへの返信のみ自動でターン開始）、`always`、`never` を選べます。

同梱の15エージェントは `intercom` を許可し、子セッションでは `subagentOnlyExtensions` でプロバイダーを読み込みます。関連作業・編集競合があるときだけ `list` で相手のID・cwdを確認し、短い `send` で共有します。`ask` はブロック時のみ、親への判断依頼は `contact_supervisor`、通常の完了は結果返却のままです。受信内容を権限や承認として扱わず、秘密情報の送信・定期通知・無断pane起動はしません。

単体Piでも使う場合は上記パッケージを登録し、ツールを制限している `~/.pi/agent/settings.json` の `defaultTools` に `intercom` を追加して再起動してください。設定チェックは `node --test extensions/leafcode-subagents/intercom-config.test.mjs` で実行できます。

### 読み上げ (`leafcode-tts`)

`extensions/leafcode-tts` は Bot / エージェントの発言を読み上げます。既定は OFF で、`/tts`（`/tts on`・`/tts off`・`/tts test`）で切り替えます。`on` / `off` / トグルは `%APPDATA%\leafcode-pi\tts.json`（Linux/macOS は `~/.leafcode-pi/tts.json`）の `enabled` に保存され、再起動後も維持されます。入力や次のエージェント開始で未再生分を捨て、発話中なら再生プロセスを止めて即断します。WebUI が依存するため、拡張機能自体は無効化できません。

文章全体をまとめて渡さず、streaming の `text_delta` を「、」「。」「！」「？」と改行で短く区切り、合成と再生を並行させる Producer/Consumer 方式です。コードブロック・URL・Markdown 記法は読み上げません。サブエージェントの子プロセスでは無効です。

既定の合成は Windows 標準の SAPI（`System.Speech`）で、追加依存はありません。日本語は `Microsoft Haruka Desktop` が使えます。**Linux/macOS に SAPI は無く、空の `url` のままだと読み上げは無音です。** AivisSpeech（`http://127.0.0.1:10101`）かカスタム HTTP を設定してください。Qwen 向けの ROCm TTS サーバー UI は同梱していません。設定は `%APPDATA%\leafcode-pi\tts.json`（Linux/macOS は `~/.leafcode-pi/tts.json`）です。

```json
{
  "enabled": false,
  "voice": "Microsoft Haruka Desktop",
  "rate": 2,
  "url": ""
}
```

`url` を設定すると SAPI の代わりにその HTTP エンドポイントで合成します。パスに応じて本文を切り替えます。

| URL | 送信 JSON |
| --- | --- |
| `.../tts` | `{ "text", "voice" }` |
| `.../v1/tts` | `{ "text", "speaker", "language": "Japanese" }` |
| `.../v1/audio/speech` | OpenAI 互換 `{ "input", "voice", "response_format": "wav" }` |

HTTP 合成の既定は AivisSpeech（`http://127.0.0.1:10101`、VOICEVOX 互換の audio_query → synthesis）です。WebUI の **設定 → エンジン → 表示と通知 → 読み上げ (TTS)** からも同じ `tts.json` を編集できます。合成に失敗したチャンクは読み飛ばし、読み上げ全体は止めません。

```powershell
npx --prefix extensions/leafcode-todowrite vitest run --dir extensions/leafcode-tts
```

## まだないもの

OpenCode 版 LeafCode にあった worktree 分離、差分ペイン、Caddy は未実装です。権限の承認 UI（Composer のモード切替と SSE の簡易承認ダイアログ）は実装済みです。エージェントはプロジェクトフォルダ上で Pi の標準ツール（read / write / edit / bash / grep / find / ls）を直接実行します。`powershell` は Windows のみ既定で有効です。

## 動作条件

| 項目 | 要件 |
| --- | --- |
| OS | Windows 10/11 x64、または Linux/macOS |
| Node.js | 22.19 以上 |
| Pi 認証 | 設定画面のサブスクログイン（Claude Pro/Max / ChatGPT Plus/Pro / Meta Muse）、環境変数、または `~/.pi/agent/auth.json` |
| Linux/macOS のプロセス検出 | `ss` または `lsof`、`ps`（WebUI の build guard / 停止に使用） |
| PowerShell（Windows のみ） | Pi 0.86.1 の標準ツール。`pwsh.exe` を優先し、なければ Windows PowerShell を使います |
| Bash（Linux/macOS） | Pi の標準シェルツール。Windows では必要時のみ明示的に有効化します |
| Linux/macOS のトレイ | グラフィカルセッションでは既定で有効。systray / AppIndicator 対応環境を推奨 |

## 起動

### Windows

リポジトリ直下の `start.bat` をダブルクリックします。初回は Node.js / 依存関係 / production build を確認し、トレイに常駐します。ソースがビルドより新しければ、本家 LeafCode と同じく起動時に `next build` し直します。準備できたら `http://127.0.0.1:3010` を開きます。

### Linux / macOS

`start.bat` は Windows 専用です。リポジトリ直下で次を実行します。`start.sh` は Node.js 22.19 以上を確認し、依存関係が無い場合だけ install してから WebUI と host を起動します。

```bash
chmod +x start.sh
./start.sh
```

手動で起動する場合は `npm --prefix web install`、`npm --prefix host install` の後に `npm run host` でも構いません。

Ubuntu / GNOME でアプリ一覧や Dock に固定できるランチャーを作成する場合は、リポジトリ直下で次を実行します。

```bash
./scripts/create-linux-launcher.sh
```

リポジトリ直下の `LeafCodePi.desktop` はチェックアウトから直接起動できるランチャー本体です。上記スクリプトはこれをアプリ一覧へ登録し、アイコンを配置します。アプリ一覧の `LeafCodePi` を右クリックして「お気に入りに追加」すると、Windows のタスクバー固定に相当する Dock 固定になります。ランチャーは現在のチェックアウトを起動し、GUI セッションではトレイも有効にします。

グラフィカルなデスクトップ（Ubuntu の通常セッション、macOS のローカル端末など）では、Windows と同様にトレイアイコンが既定で出ます。`LEAFCODE_PI_TRAY=1` は不要です。Linux で `DISPLAY` / `WAYLAND_DISPLAY` がどちらも無い SSH やサーバ起動では、トレイを自動的にスキップします（失敗ログを連発しません）。macOS は Aqua が `DISPLAY` を付けないため、`SSH_CONNECTION` / `SSH_TTY` が無いローカル起動をグラフィカルとみなします。

トレイを出さない場合は `LEAFCODE_PI_HEADLESS=1`（または `--headless`）を付けます。デスクトップでアイコンだけ消したいときは `LEAFCODE_PI_TRAY=0` です。ディスプレイ無しでも強制したいときだけ `LEAFCODE_PI_TRAY=1` を使います（`HEADLESS=1` のときは出ません）。AppIndicator 等が無くトレイ起動に失敗しても、ホストはトレイ無しで動き続けます。

```bash
./start.sh
# または
npm run host

# SSH / サーバ / トレイ無し
LEAFCODE_PI_HEADLESS=1 ./start.sh
```

ブラウザ自動起動は設定画面で有効にした場合のみ行われ、Linux は `xdg-open`、macOS は `open` を使います。

本番ビルドを使わず開発モードで起動する場合は `LEAFCODE_PI_MODE=dev npm run host` とします。`npm run dev` は WebUI だけを起動するため、host 制御 API や llama-server 連携は使いません。

本家 LeafCode と同じく、ホスト PC 上のブラウザが Tailscale / LAN IP で WebUI を開いた場合は `127.0.0.1` へ自動リダイレクトします（リモート端末はリダイレクトされません）。

ビルドが稼働中の `next start` の `.next` を置き換えたときは、そのままだと配信中の HTML が参照するチャンクが消えて `/_next/static/...` が 500 になり、キャッシュを持たないクライアント（スマホなど）に Next の "This page couldn't load" が出ます。`scripts/build-web.mjs` はビルド後に稼働中の WebUI を検出したら、ホスト制御の `POST /restart/webui` で新しい世代へ切り替えます。ホストに届かない場合はトレイの Restart WebUI が必要です。

Goal Loop は WebUI プロセス内で動くため、再起動するとセッション終了で必ず一時停止します。実行中の Goal Loop があるときは WebUI 再起動を拒否します（`POST /restart/webui` は 409、トレイの Restart WebUI と設定画面も同じ理由で拒否）。ループを停止・完了してから再起動してください。

設定画面の「WebUI を再ビルド」は、停止 → production build → 再起動を 1 操作で行います（ホスト制御の `POST /build/webui`）。ビルドの所要時間ぶん WebUI は停止し、完了後に新しいビルドを配信します。

production build は既存のミラー先を常設ビルド領域として直接使用します。Windows は **`%LOCALAPPDATA%\leafcode-pi\build\<checkout>-<hash>\`**、Linux/macOS は **`$XDG_CACHE_HOME/leafcode-pi/build/<checkout>-<hash>/`**（未設定時は `~/.cache/leafcode-pi/build/...`）で、`next start` も同じ場所から配信します。場所は従来どおり `LEAFCODE_PI_BUILD_DIR` で変更できます。

- `npm run build` と `npm --prefix web run build` は同じ入口を使います。稼働中の production WebUI を保護するため、手動ビルド前にトレイから終了してください。
- Next 16 はプロジェクト外の `distDir` を許可しないため、ソースの差分コピーだけを残します。OneDrive側の `node_modules` はビルド時に走査・同期・ハードリンクしません。
- 依存関係は初回または `package.json` / `package-lock.json` / Node.js環境の変更時に、ビルド領域で `npm ci --include=dev` します。旧ミラーも次回ビルドで移行するため、初回は依存インストールの時間・空き容量・ネットワーク接続が必要です。インストール失敗時は以前の依存関係を復元します。
- npm 12用に `web/package.json` の `allowScripts` で `better-sqlite3@12.9.0` のみを許可しています。依存インストール後はSQLiteの起動も検証します。SQLiteのバージョン更新時はこの許可も見直してください。
- `.next`・依存関係・ビルドキャッシュをOneDriveへ書き戻しません。`next dev` と開発用依存のインストール、起動後のPi 0.x自動更新は従来どおりリポジトリ側です。
- 型チェックは `next build` の中ではなく、ビルド領域の `tsc --noEmit` を `next build` と並列に実行して担保します（`web/next.config.ts` の `typescript.ignoreBuildErrors`）。型エラー時は新しいビルドを破棄し、前回の production build を復元します。

トレイメニュー:

- Open browser
- 稼働状況
- Restart WebUI
- Quit（次回起動時に必要な production build があれば、先にビルドしてから終了）

```bat
start.bat
```

開発時に WebUI だけを動かす場合:

```powershell
npm --prefix web install
npm --prefix host install
npm run dev
```

コードの確認:

```powershell
npm --prefix extensions/leafcode-todowrite install --include=dev
npm run typecheck
npm run lint
npm test
# 上記をまとめて実行
npm run check
```

デスクトップショートカットは `scripts\create-shortcut.bat` です（`LeafCodePi.lnk`。LeafCode の `LeafCode.lnk` とは別ファイルです）。

プロジェクトデータ、ホストログ、`host.lock` は Windows では `%APPDATA%\leafcode-pi\`、Linux/macOS では `~/.leafcode-pi/` に保存します。Pi セッション本体は `~/.pi/agent/sessions/` です。トレイ用 TEMP は Windows では `%LOCALAPPDATA%\leafcode-pi\tmp`、Linux/macOS ではシステムの一時ディレクトリ配下です。

## LeafCode との同時起動

同じ Windows 上で [LeafCode](https://github.com/daihaya000/LeafCode) と並べて動かせます。既定値は重なりません。

| | LeafCode | LeafCodePi |
| --- | --- | --- |
| WebUI | `http://127.0.0.1:3000` | `http://127.0.0.1:3010` |
| 環境変数 | `LEAFCODE_*` | `LEAFCODE_PI_*` |
| データ | `%APPDATA%\leafcode` | Windows `%APPDATA%\leafcode-pi` / Linux `~/.leafcode-pi` |
| トレイ TEMP | `%LOCALAPPDATA%\leafcode\tmp` | Windows `%LOCALAPPDATA%\leafcode-pi\tmp` / Linux システム一時ディレクトリ |
| ショートカット | `LeafCode.lnk` | `LeafCodePi.lnk` |
| コンソール title | LeafCode | LeafCodePi |

`LEAFCODE_PORT` を LeafCodePi に渡しても読みません。ポートを変えるときは `LEAFCODE_PI_PORT` を使います。

## 構成

- `web/` — Next.js UI と BFF
- `host/` — Next.js の起動・監視・再起動。グラフィカルデスクトップではトレイ常駐（SSH / `LEAFCODE_PI_HEADLESS=1` ではトレイなし）
- `start.bat` / `start.sh` — 導入とホスト起動
- `scripts/build-web.mjs` — production build の唯一の入口（ソース差分同期 → ローカル依存準備 → `next build` と並列の `tsc --noEmit` → BUILD_ID 検証）
- `scripts/web-build-mirror.mjs` — 既存のOneDrive外ビルド領域へのソース差分同期
- `extensions/` — Pi 拡張（Goal Loop、memory、subagents など）
- `docs/` — 実装計画と仕様
- `translation/` — 推論テキスト翻訳サービス
- `web/src/lib/pi/harness.ts` — Pi `createAgentSession` のプロセス内シングルトン
- `web/src/lib/store.ts` — プロジェクト / タスクの JSON ストア

## 環境変数

| 変数 | 内容 |
| --- | --- |
| `LEAFCODE_PI_DATA_DIR` | ストアと host.lock / host.log の保存先（未設定時は Windows `%APPDATA%\leafcode-pi`、Linux/macOS `~/.leafcode-pi`） |
| `LEAFCODE_PI_DEFAULT_DIR` | プロジェクト未登録タスクの作業ルート（未設定時は `~/Documents` があれば `~/Documents/LeafCodePi`、無ければ Linux/macOS は `$XDG_DATA_HOME/LeafCodePi` または `~/.local/share/LeafCodePi`、Windows は `%USERPROFILE%\LeafCodePi`） |
| `LEAFCODE_PI_PORT` | WebUI ポート（既定 **3010**。LeafCode の 3000 と衝突しない） |
| `LEAFCODE_PI_HOST` | WebUI 待ち受け。既定 `tailscale`（Tailscale IPv4。未検出時は 127.0.0.1）。`0.0.0.0` / 明示 IP も可 |
| `LEAFCODE_PI_HOST_CONTROL_PORT` | ホスト制御（llama-server 起動など）。既定 **18775**（LeafCode の 18765 と別） |
| `LEAFCODE_PI_LLAMA_PORT` | llama-server ポート。既定 **8081** |
| `LEAFCODE_PI_MODE` | `prod`（既定・start.bat / start.sh）または `dev` |
| `LEAFCODE_PI_BUILD_DIR` | production build のミラー先（未設定時は Windows `%LOCALAPPDATA%\leafcode-pi\build\...`、Linux/macOS `$XDG_CACHE_HOME/leafcode-pi/build/...`） |
| `LEAFCODE_PI_EXTENSIONS_DIR` | 組み込み拡張のディレクトリ（host が自動設定） |
| `LEAFCODE_PI_SKILLS_DIR` | 組み込みスキルのディレクトリ（host が自動設定、既定はリポジトリの `skills/`） |
| `XDG_CACHE_HOME` | Linux/macOS の production build ミラー基底ディレクトリ |
| `LEAFCODE_PI_USE_WEBPACK` | `1` で `next build` を Turbopack でなく webpack で行う（切り分け用） |
| `LEAFCODE_PI_HEADLESS` | `1` でトレイなし（`--headless` と同じ。`LEAFCODE_PI_TRAY=1` より優先） |
| `LEAFCODE_PI_TRAY` | 未設定はデスクトップでトレイ ON、Linux で `DISPLAY`/`WAYLAND_DISPLAY` 無しなら OFF。`0` で明示オフ、`1` でディスプレイ無しでも強制 ON |
| `LEAFCODE_PI_NO_BROWSER` | `1` で起動時にブラウザを開かない |
| `LEAFCODE_PI_NONINTERACTIVE` | `1` で失敗時の pause を省略 |
| `LEAFCODE_PI_LLAMA_SERVER_BIN` | Linux/macOS の llama-server バイナリ（未設定時は PATH の `llama-server`） |
| `LEAFCODE_PI_LLAMA_MODEL_DIR` | Linux/macOS のモデルディレクトリ（未設定時は `~/models/llm`） |
| `LEAFCODE_PI_LLAMA_GPU_DEVICE` | Linux の Vulkan デバイス（既定 `Vulkan0`） |
| `LEAFCODE_PI_LLAMA_DRAFT_MODEL` | Linux の speculative decoding 用 draft GGUF（省略可） |
| `LEAFCODE_PI_LLAMA_MMPROJ_PATH` | Linux の vision projector GGUF（省略可） |
| `ANTHROPIC_API_KEY` など | Pi が読むプロバイダーキー |


## Bot mode

LeafCodePi also provides a small Bot mode for named 1:1 assistants. Use the Code/Bot switch in the sidebar, create a bot under `/bots`, and edit its `SOUL.md` on the bot page. Bot homes live under the existing data directory (`%APPDATA%\leafcode-pi\bots` on Windows, `~/.leafcode-pi/bots` elsewhere); tools run in each bot's `workspace/`. Bots can use the bundled `intercom` tool to coordinate with other local Pi sessions; it is enabled for newly created bots and can be toggled under **使用するツール**. Rooms are available separately; routines can be created from a bot settings panel. Routines are stored under `bots/<botId>/routines/`, run as the bot in its workspace, and post results to that bot's 1:1 thread. The cron scheduler runs only while the web app process is running (opening a bot routine panel starts it); it enforces a five-minute minimum interval, a ten-routine enabled limit, and disables a routine after three consecutive failures.
