# TaskView タブ機能 要件書（LeafCodePi 版）

本家 LeafCode の [`docs/specs/taskview-tabs.md`](../../../OpenCode/LeafCode/docs/specs/taskview-tabs.md)（確定版 v2）を LeafCodePi の実態に合わせて再設計したもの。本家からの変更点は各節の「本家との差分」に明記する。

## 0. 本家計画との前提差分

| 本家計画の前提 | LeafCodePi の現状 | 再設計での扱い |
| --- | --- | --- |
| DB（better-sqlite3）+ `settings` テーブル + `user_id` マイグレーション | DB なし。汎用 settings API もない。localStorage 設定パターンが既存（`scroll-button-opacity` / `subagent-permission` 等） | **Phase 0 廃止**。永続化は localStorage。シングルユーザーのため `user_id` の概念自体が不要 |
| `TaskSplitContext` 既存（2 ペイン固定、primary=URL / secondary=メモリ） | 分割機構そのものが未実装。`/task/[id]` ページが単一 TaskView を描くだけ | N ペイン + タブ model を**新規作成**。既存 API 互換ラッパ（`primaryTaskId`/`secondaryTaskId`/`openSplit` 等）は消費者が存在しないため作らない |
| `GlobalAttentionProvider`（permission/question グローバルキュー、AttentionBadge） | 存在しない。Pi SDK プロセス内で権限要求はタイムライン上の Part として流れる | バッジは**タスク status バッジのみ**（working/error）。attention キュー導入はスコープ外 |
| viewTab 下段タブ（chat/diff/workflow）2 階層化 | viewTab 機能なし。Graph/Diff は右パネルトグル | 2 階層タブは作らない。タスクタブ（上段）のみ。Graph/Diff は現行トグルのまま |
| コマンドパレット・WS 切替対象パス | コマンドパレットなし | 対象から除外。Sidebar アクティブハイライトと Graph/Diff パネル（task.directory 由来・自動追従）だけで要件を満たす |
| サーバー永続化 `GET/PUT /api/ui-layout` | settings API なし | localStorage 直保存。API 新設なし |

## 1. 構造とペイン

- **最大 4 ペイン × 各ペイン最大 5 タブ**（本家と同じ）
- 各ペインは複数タスクをタブで保持
- **レイアウト**: ペイン単位の split tree。各分割ノードが左右（row）または上下（column）の方向を持ち、端ドロップは対象アンカーの葉だけを分割する。4 ペインでも 2x2 に固定せず、既存の他ペインの方向を変えない
- **1 ペイン × 1 タブ時は従来通り**: タブバー非表示、見た目・動作とも現行と同一
- **最小 1 ペイン制約**: 最後のペインは閉じられない。1 ペイン時の最終タブ `×` は no-op
- **モバイル（md 未満）不可**: 分割もタブも無効化し、URL タスクの単一表示へフォールバック（`matchMedia("(min-width: 768px)")`）。単純化のため md へ復帰した直後は URL タスクのみの 1 ペインから再開する
- 上限超過時の操作は reducer が no-op。`+` ボタンは上限到達時に disabled。トースト等の新規通知 UI は作らない

### レイアウトツリー

レイアウトは次の再帰構造で保持する。

- `pane`: `{ type: "pane", paneId }`
- `split`: `{ type: "split", id, orientation: "row" | "column", children: [leftOrTop, rightOrBottom] }`
- `left` / `right` の端ドロップは row、`top` / `bottom` は column とする。left/top は新しい葉を children[0]、right/bottom は children[1] に置く
- ペインを閉じたときは該当葉を除去し、片側だけになった split を縮退する
- 旧保存値に layout がなければ、従来の `orientation`（なければ row）で flat panes から一時的にツリー化する。旧 `orientation` は layout がある状態の描画方向には使わない

### 本家との差分
- 「4 ペインフル時にさらに追加 → 別ペインのタブとして追加」は廃止。どのペインに入れるかはドロップ先で明示的に指定する仕組みのため、暗黙のフォールバックは不要

## 2. プロジェクト混在とアクティブ追従

- 複数プロジェクトのタスクを同一ペインで混在可能（LeafCodePi では WS = プロジェクト）
- アクティブタブ（= アクティブペインの activeTabId）に追従して変わるもの:
  - **Sidebar のタスク一覧ハイライト・自動展開**: 現行の pathname 由来判定を provider 由来に置換
  - **Graph / Diff パネル**: TaskView 内部で `task.directory` 由来のため実装追加なしで自動追従
- URL は **アクティブペインの activeTabId** を常に指す。タブ切替・ペイン活性化のたびに `history.replaceState` で同期する（RSC fetch の発生しない方式。本家のような router.push は使わない）
- ブラウザ戻る/進む・直リンクによる外部 URL 変化は pathname 監視 effect が検知して panes 側へ反映する

## 3. タブ操作

| 操作 | 内容 |
| --- | --- |
| 追加 | Sidebar のタスクをドラッグしてペインのタブバーへドロップ |
| 新規空ペイン | タブバー端の `+` ボタン（ドロップ待ちの空ペインを追加、上限 4） |
| 閉じる | タブの `×` ボタンのみ |
| 切替 | タブクリック |
| 並び順 | 同一ペイン内をドラッグで並び替え、順序は永続化 |
| ペイン間移動 | タブを他ペインのタブバーへドロップ |
| 自動クローズ | タスク削除（アーカイブ）時に全ペインから該当タブを閉じる |

- ドラッグ MIME: `application/x-leafcodepi-task`（新規。プロジェクト並び替え `application/x-leafcode-project` とは別キー）
- HTML5 Drag & Drop 使用（Sidebar プロジェクト並び替えと同方式）。タブのキーボードドラッグはスコープ外

## 4. 状態管理

- **TaskView インスタンス**: 非アクティブタブも mount したまま（CSS `hidden` で保持、`key={taskId}`）
- **SSE 接続**: 非アクティブタブも維持。snapshot で受けた status 変化を provider へ報告し、タブバッジへ即反映
- **UI 状態**: hidden mount により Composer テキスト・graphOpen/diffOpen・スクロール位置がすべて自然に保持される（本家のように「Composer のみ保持・他は再計算」としない。LeafCodePi の stick スクロール機構が復帰時の追従を担うため追加のリセット処理が不要）
- **タスク終了後もタブは残す**: status が working 以外になっても閉じない。削除（アーカイブ、`DELETE /api/tasks/[id]`）されたときのみ自動クローズ。自動クローズ時に provider の status 報告 map からも当該 taskId を除去する
- **状態バッジ**: タブ上に working（スピン）/ error（赤点）を表示

### 本家との差分
- attention バッジ（応答待ち等）なし → status バッジのみ
- 「メモリ上 Composer のみ保持」→ 全 UI state 保持（hidden mount の自然な挙動を採用）

## 5. 永続化

- **localStorage キー `webui:task-panes`** に panes JSON（taskId 配列 + activeTabId + layout tree）を保存。500ms デバウンス
- `layout` がない旧保存値も読み込める。旧値の flat panes は `orientation`（なければ row）で描画用ツリーへ変換し、次回のレイアウト操作から tree 形式で保持する
- split のリサイズ比率は UI ローカル状態であり保存しない
- 復元順序（md 以上のときのみ実行）:
  1. URL taskId から `panes[0] = { tabs: [url], activeTabId: url }` で即時構築
  2. mount 後に localStorage を読み、保存値の中に URL taskId を含むペインがあればその構成へ差し替え。含まれない場合は保存値の panes[0] の activeTabId を URL taskId に修正して復元（直リンク互換）
- Composer テキスト・スクロール位置等の UI state は保存しない（mount 保持で賄う範囲のみ）

### 本家との差分
- DB マイグレーション・`user_id`・API route すべて不要。別ブラウザ間の同期はしない（LeafCodePi の全設定がブラウザローカル方式であり一貫している）

## 6. UI

- タブバーは各ペイン最上部に 1 本。タイトル末尾 `...` 省略、ホバーでフルタイトル
- タブ幅不足時は横スクロールではなく省略表示
- `+`（空ペイン追加）は最後のペインのタブバー右端のみ
- アクティブペインには上部アクセント線（本家 splitActive の `bg-accent` 線と同じ意匠）を表示
- ペインクリック（pointerdown / focusin）でアクティブペイン化

## 7. 互換性

- 1 ペイン × 1 タブ = 現行 `/task/[id]` と完全同等（タブバー非表示）
- Home (`/`)・settings (`/settings`) では分割ホストを非表示にするだけで、provider の panes state は保持する（Home 表示中も SSE・UI state は生存し、task へ戻るとそのまま再表示）。リセット処理は書かず、Host が null を返すだけ
- 既存テストへの影響: LeafCodePi に React コンポーネントテストは未整備（vitest node 環境のみ）のため、model 層を純関数として抽出し reducer 単体で検証する

## 8. 実装上の主要変更点

- **新規 model**: `web/src/lib/task-panes.ts` — 型・reducer・上限ガード・localStorage I/O を純関数中心で実装
- **Provider**: `web/src/components/shell/TaskPanesContext.tsx` — useReducer + URL 同期（`history.replaceState`）+ md フォールバック + status 報告 map + tasks-changed 自動クローズ
- **描画ホスト**: AppShell の `<section>` 内で layout tree を再帰レンダリング（`next/dynamic` ssr:false）。各 split node は自身の方向とリサイズ境界を持つ。`/task/[id]/page.tsx` は `null` を返す薄いページになり、URL 情報は pathname 経由で provider が取得
- **DOM/SSE リソース**: 最大 4 ペイン × 5 タブ = 20 の TaskView + EventSource。LeafCodePi の SSE は BFF 内 harness 配信で軽量だが、接続数上限に注意（リスク節参照）
