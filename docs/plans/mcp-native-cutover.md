# native MCP 切替（cutover）実測と手順

`leafcode-mcp-adapter`（同梱・既定）から Pi 標準 MCP（native）へ切り替えるときの
前提条件・手順・復旧・実測結果をまとめる。実装側の部品一覧は
`docs/plans/mcp-native-writer-cutover.md`（writer 棚卸し）を参照。

native の有効化は `LEAFCODE_PI_MCP_NATIVE=1`（Backend 起動時のみ、既定 off）。
有効時は同梱 adapter を読み込まず、Backend が所有する native runtime が
セッションへ MCP/codemode/tool_search を供給する。

## 確認ツール（読み取り専用）

```powershell
node backend/src/native-mcp-check.mjs            # flag / ACL / config / adapter の検査
node backend/src/native-mcp-check.mjs --json     # 機械可読（秘密・パスは出ない）
node backend/src/native-mcp-check.mjs --skip-storage --connect   # transport 互換のみ（受け入れではない）
```

`--skip-storage` は runtime が要求する attestation を飛ばすため、成功しても切替可の証明にはならない。
`--connect` は設定済みサーバーを実際に起動して MCP ハンドシェイクと tools/list を行うが、ツールは実行しない。

## 実測（2026-10-03・このマシン・読取りのみ）

`node backend/src/native-mcp-check.mjs`（実 agentDir・実同梱 config・書込み/接続なし）:

```
native flag requested: false
storage attestation: refused
bundled adapter present: true
issues: config-storage-refused, credentials-storage-refused
result: not ready
```

`--skip-storage --connect --json`（transport 互換の確認、`--timeout-ms=25000`）:

```json
{"connect":{"servers":{"browser-use":{"tools":16},"blendermcp":{"tools":26},"comfy-mcp":{"tools":39}}},"ok":true,"issues":[]}
```

有効な3サーバーすべてが native transport で実接続し tools/list まで通った。browser-use は起動が遅く、
既定10秒ではハンドシェイクが間に合わないため、既定の待ち時間は 30 秒にした。
MCPツールは公開設定にかかわらず登録される（codemode/deferred はモデルへの宣言だけを抑える）。

また、この過程で判明した不具合を修正した: activation が渡す環境マップに
`ProgramFiles(x86)` のような非識別子キーが含まれると transport が構築自体を拒否していた。
基底環境は任意の有効なキーを保持し、サーバー定義 `env` のキーだけ識別子を要求する。

`icacls C:\Users\Daichi\.pi\agent`:

```
X870\CodexSandboxUsers:(I)(OI)(CI)(RX)
NT AUTHORITY\SYSTEM:(I)(OI)(CI)(F)
BUILTIN\Administrators:(I)(OI)(CI)(F)
X870\Daichi:(I)(OI)(CI)(F)
```

同じ probe を、同梱既定の未解決 URL 変数エントリを落とす修正の適用後に再実行:

```
loader: ok servers= browser-use notion(off) slack(off) fxhoudini(off) blendermcp mayamcp(off) metatrader(off) mt5-build(off) comfy-mcp
config storage: REFUSED MCP private storage permissions unavailable
credential storage: REFUSED MCP private storage permissions unavailable
```

未設定の `${N8N_MCP_URL}` を持つ同梱既定 n8n は config から落ち、その他のエントリはそのまま読める。

実サーバー接続の実測（storage attestation だけを no-op にした probe。つまり transport 層の確認であり、
本番の受け入れではない）:

```
enabled browser-use: stdio exposure=codemode
enabled blendermcp: stdio exposure=codemode
enabled comfy-mcp: stdio exposure=codemode
direct MCP tools: blendermcp:26
shutdown: ok
```

blendermcp は native の stdio transport で実接続し 26 の直接ツールを登録できた。
三点とも codemode 公開なので、browser-use と comfy-mcp の接続は遅延（初回 codemode 実行時）で未検証。
また、この過程で判明した不具合を修正した: activation が渡す環境マップに
`ProgramFiles(x86)` のような非識別子キーが含まれると transport が構築自体を拒否していた。
基底環境は任意の有効なキーを保持し、サーバー定義 `env` のキーだけ識別子を要求する。

## 切替ブロッカー

1. **私的ストレージ ACL**（Windows・解決済み 2026-10-03）
   継承元の `~/.pi` から `X870\CodexSandboxUsers` ACEを削除した（`~/.pi/agent` と `mcp.json` は継承で追随）。
   復旧は同グループの `/grant:r` で戻せる。
2. ~~未解決 URL 変数~~（解決済み: 2026-10-03）
   ユーザーが URL を定義しておらず、かつ無効な同梱既定は、URL 変数が未解決なら config から落とす。
   ユーザー定義 URL と有効なエントリは従来どおり全体を拒否する（fail-closed）。
   変数を設定すれば従来どおり同梱既定が使われる。
3. ~~adapter 専用の `!command` env~~（解決済み: 2026-10-03）
   所有者（activation）が prepare 時に1回だけコマンドを実行して値を解決する。
   `!!x` は `!x` へ復号、失敗・タイムアウト・空出力はマーカーを残し、そのサーバーだけが拒否される。
   シェル実行・10秒/1MiB の上限は adapter と同一（既存設定をそのまま使える）。
   `headers` の `!` 値も同じ規則で解決する。値はログ・DTO に出さない。
4. ~~legacy `auth: "bearer"`~~（解決済み: 2026-10-03）
   移行時に `Authorization: Bearer ${VAR}`（`bearerTokenEnv`）またはリテラルヘッダ（`bearerToken`）へ変換する。
   既存の Authorization ヘッダとの衝突は `conflicting-authorization-header` で拒否する。
   同梱 n8n プリセット（bearer）はこれで通る。adapter 固有の秘密ストア
   （`bearerTokenStore` / `headersStore` / `requestHeadersCommand`）は native に等価物がなく未対応のまま。
5. ~~legacy `oauth.scopes`~~（一部解決: 2026-10-03）
   配列の `scopes` は native の単一 `scope`（空白区切り）へ変換する。
   `oauth.authorizationParams` は SDK が OAuth フローを所有するため等価物がなく、`unsupported-oauth-authorization-params` で拒否する
   （google-workspace プリセットは native 非対応。UI からの追加は native 切替後に再設計が必要）。

## 厳格ACL下での本番等価受け入れ（2026-10-03）

一時ディレクトリに実 config をコピーし、所有者のみの厳格ACLを付けて `storage attestation` を
有効にしたまま接続まで実行した（実 agentDir は変更していない）:

```
storage: ok
issues: (none)
connect: {"browser-use":{"tools":16},"blendermcp":{"tools":26},"comfy-mcp":{"tools":39}}
ok: true
```

ACLの作り方（一時ディレクトリ・実行後に削除）:

```powershell
icacls <dir> /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"
icacls <dir>\mcp.json /inheritance:r /grant:r "$env:USERNAME:F"   # inherit-only 無しの明示 FullControl が必要
```

つまり実機の `~/.pi/agent` から `X870\CodexSandboxUsers` の継承ACEを外せば同じ結果が得られる見込みで、
残る作業は ACL 変更の承認だけになる。所要時間は約1分（browser-use の起動が遅いため）。

## 切替実行（2026-10-03）

- ACL: `~/.pi/agent` の継承元 `~/.pi` から `X870\CodexSandboxUsers` のACEを削除（復旧: `icacls "%USERPROFILE%\.pi" /grant:r "$env:COMPUTERNAME\CodexSandboxUsers:(OI)(CI)(RX)"`）。
  `node backend/src/native-mcp-check.mjs` → `storage attestation: ok` / `result: ok`。
- 実機configでの実サーバー受け入れ: `--connect --timeout-ms=25000 --json` →
  `{"ok":true,"storage":"ok","connect":{"browser-use":{"tools":16},"blendermcp":{"tools":26},"comfy-mcp":{"tools":39}},"issues":[]}`。
- Hostの `backendLaunchPlan` が Backend 子プロセスへ `LEAFCODE_PI_MCP_NATIVE=1` を渡すように変更（`LEAFCODE_PI_MCP_NATIVE=0` でadapterへ即ロールバック）。
- 再起動後の実機検証: 同じflag（`LEAFCODE_PI_BACKEND_RUNTIME=1` + `LEAFCODE_PI_MCP_NATIVE=1`）で実 agentDir＋使い捨てデータディレクトリの
  実Backendを起動 → `ready: true` / `runtimeStartupIncomplete: []`（native runtime が接続できた）。
- 残り: セッションでnative MCPツールが出ることの確認（ユーザー操作）→ adapter撤去。

## 実Backendでの受け入れ（2026-10-03）

厳格ACLの一時 agentDir + 最小configで実 Backend を起動（`backend/src/native-mcp-toggle.test.mjs`、Windowsのみ）:

- `ready: true` / `runtimeStartupIncomplete: []`（storage attestation を通って native runtime が接続される）
- `PATCH /internal/mcp/servers/fixture {enabled:false}` → 200、`mcp.json` に `disabled: true` が永続化
- 再度 `{enabled:true}` → 200、`disabled` が消える

この検証で判明した不具合を修正した: `createNativeMcpActivation` が runtime へ `URL` オブジェクトを渡していた
（runtime は絶対パス文字列を要求する）ため、opt-in の native 初期化が常に失敗していた。
また runtime bundle が古いと `install()` が無く同じく失敗するため、切替前に再ビルドが必要。

## 切替手順（承認後）

1. ACL: 対象 ACE を `icacls` で削除し、`node backend/src/native-mcp-check.mjs` で
   `storage attestation: ok` と `result: ok` を確認する。
2. 変数（解決済み）: 未設定のままにする場合は同梱既定が自動で落ちる。使う場合は env を設定する。
3. `node scripts/build-backend-runtime.mjs` で runtime bundle を作り直す（ビルド成果物。Host はソースstampで
   自動再ビルドするが、手動確認時は明示的に。古い bundle は `install()` を持たず native 初期化が必ず失敗する）。
4. `LEAFCODE_PI_MCP_NATIVE=1` を Backend/Host の環境に設定し、Backend を再起動する。
   native 初期化に失敗した場合は runtime が未接続のまま起動し（adapter への黙った fallback なし）、
   health の `runtimeStartupIncomplete` に `initializeRuntime` が載る。全体停止にはならない。
   この挙動は実プロセスで検証済み（`backend/src/native-mcp-entry.test.mjs`: 不正な config でも
   Backend は 503 で応答を続け、`initializeRuntime` を報告する）。
5. 受け入れ（すべて実サーバーで確認するまで完了扱いにしない）:
   - `node backend/src/native-mcp-check.mjs --connect` が `result: ok`（実サーバー接続を含む）
   - 起動時に `[mcp-native]` の警告が出ない
   - 実サーバー（blendermcp / comfy-mcp / browser-use）で接続・`tools/list`・1ツール実行
   - ON/OFF トグルと preset 追加が再公開される（応答後に新規セッションへ反映）
   - Backend 再起動後も同じ結果になる
6. adapter 撤去（別コミット）: bundled 読み込み対象から `leafcode-mcp-adapter` を外し、
   `FORK_REPLACED_EXTENSIONS` と profile 書込み 503 を維持する。同梱既定の MCP 定義は
   `backend/core/mcp-defaults.json` へ移済み（全参照切替済み）。移行直後の稼働中プロセスは旧パスを
   参照したままなので、再起動までは旧パスに互換コピーを残す。再起動後（Hostがbundleを自動再ビルド）に
   旧コピーと `extensions/leafcode-mcp-adapter/` を削除する。

## 復旧

- flag を外して Backend を再起動すれば adapter 経路に戻る（native 側は設定を書かないためデータ影響なし）。
- ACL 変更は元の ACE を再付与すれば戻せる（変更前の `icacls` 出力を保存しておく）。

## 未実装ゲート（切替後も残る）

- 認証情報の書込み: native 中は bearer/headers/OAuth の保存操作が 409。
  OAuth は SDK の接続時フロー（openUrl + callback）へ置き換える設計判断が必要。
  bearer を config `headers` へ平文保存するのは既存の秘密ストアより劣化するため実装しない。
- 実行中セッションの reload: ON/OFF・preset 書込みは応答後に provider を再公開し、`reloadLiveSessionsContext()` の
  `session.reload()` が loader を再実行するため、そのセッションにも反映される（harness は provider を
  loader 実行ごとに解決する）。外部 writer が直接書き換えた場合は再起動まで反映されない。
- adapter 固有の設定面: `MCP_DIRECT_TOOLS` env、`settings.mcp`、プロジェクト `.pi/mcp.json` は
  native が読まない（この環境ではいずれも未使用を確認済み）。使う場合は別途対応が必要。
  adapter 固有の秘密ストア（`bearerTokenStore` / `headersStore` / `requestHeadersCommand`）も未対応。
- CLI/adapter writer 群の一本化、migration apply（`configuration-writers-not-quiesced`）。
- 実サーバー受け入れ（上記4）は transport 層のみ確認済み。flag を入れた本番受け入れは未実施。
