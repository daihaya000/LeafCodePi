---
name: blendermcp
description: Blender Lab 公式 MCP 拡張を使い、リモート Blender (100.127.32.3, Tailscale) のシーン・オブジェクト・ドキュメント・レンダリングを操作するときの手順と注意点。公式クライアント、null byte TCP、検証ルールを前提にする。
---

# Blender Lab MCP 操作ガイド

Blender Lab 公式 `MCP` 拡張（Blender 5.1 系、画面の Maintainer: Blender Lab）を
リモート Blender（Tailscale `100.127.32.3`）で使う。公式ソースは
`https://projects.blender.org/lab/blender_mcp`。

ローカル MCP サーバーは公式リポジトリの `mcp/` パッケージを専用 venv に
インストール済み:

- venv: `~/.pi/agent/mcp-venvs/blender-mcp`
- MCP 設定: `~/.pi/agent/mcp.json` の `blendermcp`
- 公式ソース clone: `~/.pi/agent/git/projects.blender.org/lab/blender_mcp`
- 接続先環境変数: `BLENDER_MCP_HOST=100.127.32.3` / `BLENDER_MCP_PORT=9876`

## リモート側の設定

Blender の Extensions で Blender Lab の `MCP` 拡張を有効化する。
Preferences で次を設定し、`Server is running` を確認する:

- Host: `100.127.32.3`
- Port: `9876`
- Auto Start: 有効（または `Start MCP Server` を押す）

公式アドオンと公式 MCP サーバーは **null byte (`\\0`) 区切り JSON over TCP**で
通信する。`ahujasid/blender-mcp`（コミュニティ版）の JSON/WebSocket 系クライアント
とは互換性がない。`BLENDER_HOST` / `BLENDER_PORT` ではなく、公式版の
`BLENDER_MCP_HOST` / `BLENDER_MCP_PORT` を使う。

## 接続の確認

まず `get_objects_summary` または `get_blendfile_summary_datablocks` を呼び、
リモートシーンの情報が返ることを確認する。TCP ポートが開いていても、アドオンが
応答しなければ MCP 操作は失敗する。

- TCP 接続拒否: Blender 未起動、サーバー未起動、またはファイアウォール
- TCP 接続成功・ツールタイムアウト: アドオンの停止、互換性違い、Blender の
  メインスレッド停止を確認。`Stop MCP Server` → `Start MCP Server`、必要なら
  Blender 完全再起動
- 接続後は `get_screenshot_of_window_as_json` または画像取得ツールで状態を確認

## ツールの優先順位

1. 調査: `get_objects_summary`, `get_object_detail_summary`,
   `get_blendfile_summary_*`
2. 画面: `get_screenshot_of_window_as_image`,
   `get_screenshot_of_area_as_image`, `get_screenshot_of_window_as_json`
3. 移動・表示: `jump_to_tab_by_name`, `jump_to_tab_by_space_type`,
   `jump_to_view3d_object_by_name`
4. ドキュメント: `search_api_docs`, `search_manual_docs`, `get_python_api_docs`
5. 作業: `render_thumbnail_to_path`, `render_viewport_to_path`
6. 最終手段: `execute_blender_code`

`*_for_cli` ツールは既存ファイルをバックグラウンド Blender で開く用途であり、
現在のリモート GUI セッションを操作するツールとは区別する。

## 検証ルール

- 変更前に対象オブジェクト・コレクション・モード・選択状態を調べる。
- `execute_blender_code` は `result` に JSON 直列化可能な dict を代入する。
- 作成・変更後は同じ要素を再取得して、名前・属性・階層を確認する。
- 視覚的な変更後はスクリーンショットを取得する。
- 成功応答だけで完了を主張しない。

## セキュリティ

公式ページも警告している通り、MCP は LLM 生成コードを Blender 内で実行し、
データ削除や外部送信を防ぐサンドボックスではない。Host は `0.0.0.0` ではなく
Tailscale IP `100.127.32.3` に限定し、信頼できる MCP クライアントだけを接続する。
