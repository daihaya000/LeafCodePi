# native MCP 切替（cutover）実測と手順

`leafcode-mcp-adapter`（同梱・既定）から Pi 標準 MCP（native）へ切り替えるときの
前提条件・手順・復旧・実測結果をまとめる。実装側の部品一覧は
`docs/plans/mcp-native-writer-cutover.md`（writer 棚卸し）を参照。

native の有効化は `LEAFCODE_PI_MCP_NATIVE=1`（Backend 起動時のみ、既定 off）。
有効時は同梱 adapter を読み込まず、Backend が所有する native runtime が
セッションへ MCP/codemode/tool_search を供給する。

## 実測（2026-10-03・このマシン・読取りのみ）

実 agentDir と同梱 config で `prepare()` を実行（書込み・接続・セッション起動なし）。
使い捨てスクリプトは実行後に削除した。

```
config storage: REFUSED (MCP private storage permissions unavailable)
credential storage: REFUSED (MCP private storage permissions unavailable)
loader: issues=[unresolved-url-variable ...]
prepare: FAILED
```

`icacls C:\Users\Daichi\.pi\agent`:

```
X870\CodexSandboxUsers:(I)(OI)(CI)(RX)
NT AUTHORITY\SYSTEM:(I)(OI)(CI)(F)
BUILTIN\Administrators:(I)(OI)(CI)(F)
X870\Daichi:(I)(OI)(CI)(F)
```

## 切替ブロッカー（解決が必要）

1. **私的ストレージ ACL**（Windows）
   上記の継承 ACE `X870\CodexSandboxUsers:(I)(OI)(CI)(RX)` が strict policy で拒否される。
   `mcp.json` / `mcp-auth.json` も同じ継承で拒否される。
   解除は対象 ACE の削除（要承認）。ポリシー緩和で回避しない。
2. **未解決 URL 変数**
   同梱 `extensions/leafcode-mcp-adapter/mcp.json` の n8n `${N8N_MCP_URL}` と
   slack `oauth.clientId ${SLACK_CLIENT_ID}` が未設定だと、native loader は
   「未使用（既定 disabled）の同梱既定」でも全体を拒否する（fail-closed）。
   n8n/slack を使わない環境では、ユーザーが上書きしていない既定サーバーの未解決分を
   落とす方針変更が必要（未実装・要判断）。使う場合は env を設定する。

## 切替手順（承認後）

1. ACL: 対象 ACE を `icacls` で削除し、上記実測を再実行して
   `config storage: ok` / `credential storage: ok` を確認する。
2. 変数: ブロッカー2 を方針決定どおりに解消する。
3. `LEAFCODE_PI_MCP_NATIVE=1` を Backend/Host の環境に設定し、Backend を再起動する。
4. 受け入れ（すべて実サーバーで確認するまで完了扱いにしない）:
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
- 実サーバー受け入れ（上記4）は未実施。
