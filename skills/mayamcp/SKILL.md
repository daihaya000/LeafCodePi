---
name: mayamcp
description: リモート Maya (100.127.32.3, Tailscale) を PatrickPalmer/MayaMCP MCP サーバー経由で操作するときの手順と注意点。Maya シーン構築・モデリング・マテリアルの依頼に使う。commandPort の前提条件と検証ルールでミスを防ぐ。
---

# MayaMCP 操作ガイド

リモートの Maya（Tailscale `100.127.32.3`）に、PatrickPalmer/MayaMCP
（GitHub 星数最高位の Maya MCP 実装、commandPort 経由）で接続する。
MCP 設定は `~/.pi/agent/mcp.json` の `mayamcp` サーバー。

- 本体クローン: `~/.pi/agent/git/github.com/PatrickPalmer/MayaMCP`
- 専用 venv: `~/.pi/agent/mcp-venvs/maya-mcp`（mcp<2 が必要。upstream の
  requirements.txt は未ピンのため venv を共用しない）
- ランチャー: `src/maya_mcp_remote.py`（upstream は 127.0.0.1 ハードコードの
  ため、`MAYA_HOST` / `MAYA_PORT` 環境変数で MayaConnection を差し替える薄い
  ラッパー。upstream 更新時はこのファイルだけ維持すればよい）
- 接続先: `MAYA_HOST=100.127.32.3` `MAYA_PORT=50007`

## リモート側の前提条件

1. **commandPort を開く**: Maya は既定で commandPort を開かない。Script Editor
   か `userSetup.mel` に以下を追加する:

   ```mel
   commandPort -name ":50007" -sourceType "mel";
   ```

   MayaMCP は Python コードを MEL の `python("...")` で包んで送るため、
   `sourceType` は `mel` にする。`python` にすると `name 'python' is not defined`
   になる。

   Maya の `:50007` は `127.0.0.1` にバインドされる。`Get-NetTCPConnection` の
   `LocalAddress` が `127.0.0.1` になるのは正常だが、そのままでは Tailscale
   経由の直接接続はできない。

2. **Tailscale 側へ中継する**: リモート Windows の管理者 PowerShell で、Maya の
   loopback commandPort を Tailscale アドレスへ中継する:

   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=100.127.32.3 listenport=50007 connectaddress=127.0.0.1 connectport=50007
   ```

   確認:

   ```powershell
   netsh interface portproxy show all
   Get-NetTCPConnection -LocalPort 50007 -State Listen
   ```

   さらに Windows Firewall は、MCP クライアントの Tailscale IP `100.98.131.68`
   から `100.127.32.3:50007` だけを許可する。Firewall だけでは loopback の
   commandPort は外部公開されない。

3. **セキュリティポップアップ**: 初回接続時に Maya 内で警告が出るので、
   リモート側で「Allow All」を押す。**Maya セッション毎に出直す**ので、
   接続が急に通らなくなったらまずこれを疑う。
4. 失敗時の切り分け: Maya 未起動 → commandPort の `sourceType` 違い →
   portproxy 未登録 → Firewall → ポップアップ未承認、の順で確認する。

## ツールの最重要ルール

### 1. 17 ツールの優先順位

1. 専用ツールを優先: `create_object`, `mesh_operations`, `create_material`,
   `create_curve`, `curve_modeling`, `organize_objects`,
   `create_advanced_model`, `generate_scene`
2. 汎用は `list_objects_by_type` / `get_object_attributes` /
   `set_object_attributes` で読み書き
3. シーン操作: `scene_new`（force 引数に注意・未保存シーンは拒否される）/
   `scene_open` / `scene_save`

### 2. 通信設計の特性（upstream 固有）

- 1 ツール呼び出し = commandPort へ 2 接続（実行 + 結果読み取り）。高速な
  連続呼び出しより、必要最小限の呼び出しにまとめるほうが安全。
- 送信 Python コードは `_mcp_maya_scope()` にスコープされるためグローバル
  名前空間を汚さないが、**マルチライン実行は戻り値が返らない**制約がある。
  値が必要なら専用ツールを使う。
- 新ツール追加は `mayatools/thirdparty/` に Python ファイルを置くだけ
  （upstream 設計）。引数には型アノテーション必須。

### 3. 今回の接続・デバッグ教訓

- `:50007` は Maya の仕様上 `127.0.0.1` 待受。外部接続には Windows の
  `netsh interface portproxy` と、MCP クライアントの Tailscale IP
  `100.98.131.68` だけを許可する Firewall ルールを併用する。
- `sourceType` は `mel` 固定。`python` にすると `name 'python' is not defined`。
- MayaMCP は一次実行と結果取得の2接続。一次実行の戻り値は payload ではないため、
  ローカル修正 `2ccb32f` で `catchQuiet(python("..."))` とし、Maya の
  「数値または文字列値ではなく、表示できません」警告を抑制する。実データは
  二次接続で `_mcp_maya_results` を取得する。
- `create_object.py` はMEL内の引用符問題を避けるローカル修正 `f478a45` 済み。
  再インストールで上書きした場合は再適用する。
- 操作成功はMCP応答だけで判断せず、`list_objects_by_type` /
  `get_object_attributes` で再取得する。Mayaコンソールの表示警告と、MCPの
  `isError` は別に判定する。
- パイプで手動テストする場合、`MAYA_HOST` / `MAYA_PORT` は実際に起動する
  `maya_mcp_remote.py` 側へ付ける。ログの `remote target` も確認し、左辺の
  入力生成プロセスだけに設定しない。

### 4. 検証してから主張する

- 作成・変更後は `list_objects_by_type` と `get_object_attributes` で
  実際のノード・属性値を読む。成功応答だけで「できた」と主張しない。
- 既知の upstream 不具合: `generate_scene` ツールはプリロード時に構文エラー
  で登録されない（ログに "Unable to pre-load generate_scene"）。他ツールは
  正常なので、シーン一括生成は個別ツールの組み合わせで行う。

## ローカル直接テスト（MCP 経由不可のとき）

```bash
cd ~/.pi/agent/git/github.com/PatrickPalmer/MayaMCP/src
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | \
  MAYA_HOST=100.127.32.3 ~/.pi/agent/mcp-venvs/maya-mcp/Scripts/python.exe maya_mcp_remote.py
```
