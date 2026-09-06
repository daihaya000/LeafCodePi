---
name: fxhoudinimcp
description: リモート Houdini (100.127.32.3, Tailscale) を fxhoudinimcp MCP サーバー経由で操作するときの手順と注意点。Houdini シーン構築、シミュレーション、レンダリング、検証の依頼に使う。バッチ構築・検証・ツール優先順位のルールでミスを防ぐ。
---

# FXHoudini-MCP 操作ガイド

Houdini 21.0.559 が Tailscale `100.127.32.3` で稼働中。ローカル pi から
fxhoudinimcp MCP サーバー（stdio）経由で操作する。MCP 設定は
`~/.pi/agent/mcp.json` に `HOUDINI_HOST=100.127.32.3` `HOUDINI_PORT=8100`。

## 接続の確認

ツール `get_houdini_connection_status`（または `scene.get_scene_info`）で
Houdini への接続とバージョンを確認してから作業を始める。接続失敗時は
「Cannot reach Houdini at http://100.127.32.3:8100」が出る。原因はリモートの
Houdini 未起動 or プラグイン停止。リモート側で Houdini を再起動してもらう。

## 188 ツールの最重要ルール

### 1. バッチで構築する（1回の呼び出しにまとめる）

HOM は main thread 専用で、**1回の呼び出しに約 50ms の固定コスト**がかかる。
10 ノードを 1 個ずつ作ると 800ms、1 回の `build_network` にまとめると 66ms。

- 3 ノード以上: グラフ全体を設計して **1 回の `build_network`** で構築する。
  未知のノードタイプは `build_network(dry_run=True)` で事前検証（シーンに触れない）。
- パラメータは `set_parameters`（バッチ）、接続は `connect_nodes_batch`。
- 検証は `verify_network(parent)` を 1 回。

### 2. 推測するな、調べろ

- `get_node_card(node_type, context)`: 実在のコネクタ名・パラメータ名・
  デフォルト値・メニュー・ヘルプを返す（**このバージョンに正確**）。
- `search_help(query)` + `get_help_page(path)`: 同梱のヘルプコーパス全文検索。
- `list_node_types(context, filter)`: 専用ノードが既に存在するか必ず確認。
  VEX wrangle / execute_python を使う前に必ず実行する。
- パラメータ名の推測は**失敗の第1原因**。マルチパームの `#` はテンプレート
  （実名は `source_volume1` 等）。

### 3. 検証してから主張する

- 構築後は必ず `verify_network(parent)` で error_nodes とジオメトリ数を読む。
- 視覚マイルストーンでは `capture_screenshot` で実際の画像を確認する。
- シミュレーションの進行は `cook_frame_range(node_path, start, end)` で
  フレームごとの調理時間・エラー・カウントを**1回で**得る。`set_frame` を
  ループで回すな、`execute_python` でフレームを進めるな。
- 数値は生値ではなく統計で: `get_attrib_stats` / `get_volume_info`。

### 4. ツール優先順位

1. `build_network` / `build_sop_chain` — 全体を1回の検証付き呼び出しで
2. ワークフローツール: `setup_pyro_sim`, `setup_rbd_sim`, `setup_flip_sim`,
   `setup_vellum_sim`, `create_light_rig`, `setup_render`, `create_material`
3. `create_node` + `connect_nodes_batch` — 既存ネットワークへの小編集
4. `create_wrangle` — 専用ノードが無い場合のみ（`list_node_types` 済み必須）
5. `execute_python` — **最終手段**。ノード作成・パラメータ設定・接続に使うな

wrangle を作成/編集したら直後に `validate_vex` を呼び、エラーが無くなるまで進めない。

### 5. その他の作法

- パラメータは式も扱える: `set_expression` / `get_expression` /
  `link_parameters`（チャンネル参照）/ `revert_parameter`。式をリテラルで
  上書きすると File Cache の出力パス等が壊れる。
- シェルフツールが必要なセットアップ（ocean 等）は `list_shelf_tools` /
  `get_shelf_tool_script` / `run_shelf_tool`。`build_network` では作れない。
- Solaris は `set_viewer_context("/stage", ...)` を最初に。無いと
  `set_viewport_renderer` が拒否する。
- シーンを閉じる/保存する前にキャッシュ: シミュ後は `filecache`
  （RBD/Vellum は `rbdio`/`vellumio`）。HIP を先に保存する（キャッシュパスが
  `$HIP` 基準のため）。

## MCP プロンプト（ワークフローガイド）の使い方

MCP の `prompts/get` で 9 本のガイドを取得できる。大掛かりな構築の前に
該当ガイドを読むとミスが減る:

| プロンプト名 | 用途 |
|---|---|
| `procedural_modeling_workflow` | SOP プロシージャルモデリング |
| `simulation_setup` (sim_type: pyro/flip/rbd/vellum/mpm/pop) | シミュレーション |
| `usd_scene_assembly` | LOPs/Solaris USD シーン |
| `pdg_pipeline` | PDG/TOPs パイプライン |
| `hda_development` | HDA 作成 |
| `copernicus_workflow` | Copernicus (COPs) イメージワーク |
| `heightfield_terrain` | ハイトフィールド地形 |
| `houdini_workflow` (topic 任意) | 汎用トピックガイド |
| `debug_scene` | シーンのデバッグ手順 |

## HTTP ブリッジ直接呼び出し（MCP ツールが無い場合の代替）

pi の MCP ツールが使えない状況で、リモート Houdini を直接検証・操作したい
場合は HTTP ブリッジに POST できる:

```python
import httpx, json
base = "http://100.127.32.3:8100/api"
def rpc(command, params=None, timeout=30):
    meta = {"command": command, "params": params or {}, "request_id": "x"}
    body = {"json": json.dumps(["mcp.execute", [], meta])}
    r = httpx.post(base, data=body, timeout=timeout)
    return r.json()
```

- コマンド名は `nodes.create_node`, `geometry.get_geometry_info` 等のドット形式。
- 一覧は `rpc("list_commands")` のエラー応答の `available_commands` に含まれる。
- ヘルスチェック: `POST /api` body `{"json": '["mcp.health", [], {}]'}`。
- スクリーンショット: `viewport.capture_screenshot` の `image_base64` に
  JPEG base64 が返る。

## やってはいけないこと

- `execute_python` でノード作成・パラメータ設定・接続・Python SOP を書く
- パラメータ名を推測して設定する（先に `get_node_card` か `get_parameters`）
- 成功応答だけで「できた」と主張する（`verify_network` で確認する）
- ノードを 1 個ずつ作る（バッチでまとめる）

## 初心者向けモデリングの定石（Qiita記事の整理）

出典: [初心者向けノードサンプル集](https://qiita.com/d658t/items/1a44518523f8ffb14cd4)、Houdini 18.0時点の内容。現在のバージョンではノードカードで名称・パラメータを確認してから使う。

### まず覚えるノードの対応表

- トポロジを保った平滑化: `Smooth`
- 法線方向への押し出し／法線反転: `Peak`／`Reverse`
- カーブの切り出しと点の生成: `Carve`（`Extract`）
- 形状への投影: `Ray`
- 切断・結合・リダクション: `Boolean`／`VDB from Polygons` → `Convert`／`Poly Reduce`
- 反復配置: `Copy and Transform`、ポイントへの配置: `Copy to Points`
- パスの立体化: `Sweep` または `Poly Wire`
- 画像から輪郭・マスクを作る: `Trace`、`Attribute from Map` → `Scatter` → `Copy to Points`
- 破砕: `Iso Offset` → `Scatter` → `Voronoi Fracture`（確認には `Exploded View`）
- 点列から滑らかな紐を作る: `Add`（By Group）→ `Convert`（NURBS）→ `Resample` → `Sweep`

### グループを先に設計する

グループは選択状態を後段へ渡す仕組み。`Group Create` の条件選択、`Group Promote` の要素種別変換、`Group Expand` の隣接拡張、`Group Combine` の論理合成を使い、後続ノードの対象を限定する。

- 上向き面: `Group Create` の法線条件（例: `(0, 1, 0)`）
- 穴の境界: `Group Create` の `Unshared Edges`
- エッジ角度／長さ: `Include by Edges` の `Min Edge Angle`／`Min Edge Length`
- UVシーム／ハードエッジ: `Group from Attribute Boundary`（属性 `uv`／`N`）
- 一定間隔の選択: `Group by Range` のステップ指定
- 2点間・閉ループ: `Group Find Path`、閉じる場合は `Path Ending = Close Path`

### 小さなプロシージャル例

- チュロス形状: `Circle` → `Group by Range` で交互の点を選択 → `Transform` でスケール。
- 雪: 上向き面をグループ化 → `Scatter` → `VDB from Particles`。
- 石: `Sphere` → `Mountain` でノイズ変形。
- レンガ: `Box` → `Attribute Randomize` で `pscale` → `Poly Bevel` の幅へ利用。
- 石橋: 半円カーブ → `Carve` で中心点を取得 → `Copy to Points` で脚を配置。
- 壊れた木: `Line` → `Point Jitter` → `Copy to Points` で `Grid` を配置。

### 作業時の補助

パラメータエディタのフィルタを `Parameters with Non-Default Values` にすると、変更点だけを確認できる。サンプルの考え方を流用するときも、まず単純なノード列で成立させ、必要なグループ・属性だけを追加する。
