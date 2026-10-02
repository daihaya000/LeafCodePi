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

`--skip-storage --connect --json`（transport 互換の確認）:

```json
{"ok":true,"storage":"skipped","servers":[{"name":"browser-use","enabled":true,"transport":"stdio","exposure":"codemode"},{"name":"blendermcp","enabled":true,"transport":"stdio","exposure":"codemode"},{"name":"comfy-mcp","enabled":true,"transport":"stdio","exposure":"codemode"},...],"connect":{"directTools":{"blendermcp":26},"browserRequested":false},"issues":[]}
```

blendermcp は native の stdio transport で実接続し 26 の直接ツールを登録できた。
三点とも codemode 公開なので、browser-use と comfy-mcp の接続は遅延（初回 codemode 実行時）で未検証。
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

1. **私的ストレージ ACL**（Windows・未解決）
   上記の継承 ACE `X870\CodexSandboxUsers:(I)(OI)(CI)(RX)` が strict policy で拒否される。
   `mcp.json` / `mcp-auth.json` も同じ継承で拒否される。
   解除は対象 ACE の削除（要承認）。ポリシー緩和で回避しない。
2. ~~未解決 URL 変数~~（解決済み: 2026-10-03）
   ユーザーが URL を定義しておらず、かつ無効な同梱既定は、URL 変数が未解決なら config から落とす。
   ユーザー定義 URL と有効なエントリは従来どおり全体を拒否する（fail-closed）。
   変数を設定すれば従来どおり同梱既定が使われる。

## 切替手順（承認後）

1. ACL: 対象 ACE を `icacls` で削除し、`node backend/src/native-mcp-check.mjs` で
   `storage attestation: ok` と `result: ok` を確認する。
2. 変数（解決済み）: 未設定のままにする場合は同梱既定が自動で落ちる。使う場合は env を設定する。
3. `LEAFCODE_PI_MCP_NATIVE=1` を Backend/Host の環境に設定し、Backend を再起動する。
4. 受け入れ（すべて実サーバーで確認するまで完了扱いにしない）:
   - `node backend/src/native-mcp-check.mjs --connect` が `result: ok`（実サーバー接続を含む）
   - 起動時に `[mcp-native]` の警告が出ない
   - 実サーバー（blendermcp / comfy-mcp / browser-use）で接続・`tools/list`・1ツール実行
   - ON/OFF トグルと preset 追加が再公開される（応答後に新規セッションへ反映）
   - Backend 再起動後も同じ結果になる
5. adapter 撤去（別コミット）: bundled 読み込み対象から `leafcode-mcp-adapter` を外し、
   `FORK_REPLACED_EXTENSIONS` と profile 書込み 503 を維持する。

## 復旧

- flag を外して Backend を再起動すれば adapter 経路に戻る（native 側は設定を書かないためデータ影響なし）。
- ACL 変更は元の ACE を再付与すれば戻せる（変更前の `icacls` 出力を保存しておく）。

## 未実装ゲート（切替後も残る）

- 認証情報の書込み: native 中は bearer/headers/OAuth の保存操作が 409。
  OAuth は SDK の接続時フロー（openUrl + callback）へ置き換える設計判断が必要。
- 実行中セッションの reload: 設定変更は新規セッションのみに反映される。
- project config・CLI/adapter writer 群の一本化、migration apply
  （`configuration-writers-not-quiesced`）。
- 実サーバー受け入れ: transport 層は blendermcp で確認済み。ACL 承認後に flag を入れた
  本番受け入れ（codemode 経由の browser-use / comfy-mcp を含む）を行う。
