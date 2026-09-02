# TaskView タブ機能 実装計画（LeafCodePi 版）

**仕様:** [`docs/specs/taskview-tabs.md`](../specs/taskview-tabs.md)

**ゴール:** `/task/*` に複数タスクをタブで開き、最大 4 ペインまで分割できるようにする。ペイン単位の split tree と各ノードの方向を localStorage に永続化し、1 ペイン × 1 タブでは現行と完全同等の見た目を維持する。

**技術:** Next.js（App Router）、React、TypeScript、Vitest（node 環境・Testing Library なし）。DB / settings API は使わない。

## 本家計画（v2）からの変更サマリ

| 本家 Phase | LeafCodePi 版での扱い |
| --- | --- |
| Phase 0: DB マイグレーション（settings + user_id） | **廃止**。永続化は localStorage |
| Phase 1: TaskSplitContext N ペイン化 | 新規 `lib/task-panes.ts`（model）+ `TaskPanesContext.tsx`。後方互換ラッパ不要 |
| Phase 2: AppShell N ペイン対応 | AppShell へ Provider + Host を組込。page.tsx を null 化 |
| Phase 3: TaskView タブ UI + hidden mount | 同左。viewTab 下段タブはスコープ外 |
| Phase 4: Sidebar N ペイン対応 | タスク行 draggable 化 + activeTaskId を provider 由来に置換 |
| Phase 5: サーバー永続化 | localStorage 化（Phase 1 に吸収） |
| Phase 6: WS 混在切替 + attention バッジ | status バッジのみに縮小（attention 機構が存在しないため）。Graph/Diff は自動追従 |
| Phase 7: 統合・回帰 | typecheck + vitest + 手動確認 |

## 全体制約

- 各 Phase は「変更 → 検証 → 即コミット」で完結させる。
- `next dev` / `next build` / watch 系を実行しない。検証は `npm --prefix web run typecheck` と `npm --prefix web test` に限定する。
- `TaskView.tsx` / `Sidebar.tsx` / `AppShell.tsx` は競合しやすいため Phase 順に編集し、編集直前に再読込する。
- 既存回帰対象: Home からの新規タスク作成→push、Sidebar プロジェクト並び替え DnD、Goal Loop、TodoProgressPanel、Graph/Diff パネル。

## フェーズ構成

```text
Phase 1  task-panes model（型・reducer・localStorage）
   └─ Phase 2  TaskPanesContext + AppShell 組込（1 ペインで従来再現）
        ├─ Phase 3  TaskTabs UI + hidden mount + status バッジ
        ├─ Phase 4  DnD（Sidebar ドラッグ・ペイン間移動・空ペイン追加）
        └─ Phase 5  統合・回帰
```

---

## Phase 1: `web/src/lib/task-panes.ts`（model 層）

新規ファイル。React 非依存の純関数として実装し、vitest で直接テストする。

```ts
export const MAX_PANES = 4;
export const MAX_TABS_PER_PANE = 5;
export const TASK_PANES_STORAGE_KEY = "webui:task-panes";

export type TaskPane = { id: string; tabs: string[]; activeTabId: string | null };

export type PaneLayout =
  | { type: "pane"; paneId: string }
  | {
      type: "split";
      id: string;
      orientation: "row" | "column";
      children: [PaneLayout, PaneLayout];
    };

export type TaskPanesState = {
  panes: TaskPane[];            // 最小 1、最大 MAX_PANES
  activePaneId: string | null;
  layout?: PaneLayout;          // 旧保存値では未指定
  orientation?: "row" | "column"; // layout がない旧値の互換用
};

// reducer アクション
type Action =
  | { type: "openTab"; paneId: string; taskId: string }      // 重複時は activateTab に寄せる
  | { type: "closeTab"; paneId: string; taskId: string }     // 最終タブを閉じたら最終ペインを閉じる
  | { type: "activateTab"; paneId: string; taskId: string }
  | { type: "reorderTabs"; paneId: string; tabs: string[] }
  | { type: "moveTab"; fromPaneId: string; toPaneId: string; taskId: string; index?: number }
  | { type: "addPane" }          // 空ペイン追加（上限で no-op）
  | { type: "closePane"; paneId: string }
  | { type: "activatePane"; paneId: string }
  | { type: "replace"; state: TaskPanesState };  // 復元用
```

- 上限ガードは reducer 内で enforce（超過 = 前状態を**同一参照**のまま返す no-op）。呼び出し側は `prev === next` 比較で拒否を検知できるが、原則として UI 側で上限到達時に操作不能（disabled）にするため通知は不要
- **最小 1 ペイン制約**: `closeTab` でペイン最終タブを閉じた場合のペイン閉鎖は `panes.length > 1` のときのみ。1 ペイン時はタブもペインも閉じない。activeTabId / activePaneId の繰り上げ規則: 閉じた位置の右隣、端なら左隣
- localStorage I/O: `loadTaskPanes()` / `saveTaskPanes(state)`。破損 JSON・上限違反値は無視して `null` / 正規化済みを返す。layout がない旧保存値も flat panes + orientation から互換変換する
- direction 付き `openInNewPane` は anchor の葉だけを row/column split に置き換え、他の subtree の方向を変更しない。`openTab` など layout を変更しない操作は layout / orientation を保持する
- **テスト**: `web/src/lib/task-panes.test.ts` — open/close/activate/reorder/move/addPane/closePane の遷移、上限ガード、activeTabId 繰り上げ、anchor 局所分割・tree 縮退、旧形式互換、localStorage roundtrip（node 環境のため `globalThis.localStorage` を Map 実装でスタブ）

**検証**: `npm --prefix web test -- src/lib/task-panes.test.ts`、`npm --prefix web run typecheck`

---

## Phase 2: `TaskPanesContext` + AppShell 組込（1 ペインで従来再現）

**ファイル**: 新規 `web/src/components/shell/TaskPanesContext.tsx`、`web/src/components/shell/AppShell.tsx`、新規 `web/src/components/task/TaskPanesHost.tsx`、`web/src/app/(app)/task/[id]/page.tsx`

### TaskPanesContext（Provider）

- state: `useReducer(reducer, 初期 = URL taskId から構築)`
- URL 同期（`history.replaceState` 方式）:
  - タブ切替・ペイン活性化では「アクティブになったペインの activeTabId」へ `window.history.replaceState(null, "", /task/<id>)` で同期（Next.js App Router は replaceState を公式サポート。router.push は RSC fetch が発生するため使わない）
  - pathname 監視 effect は**外部遷移専用**: ブラウザ戻る/進む・直リンクで URL が変化したとき、`taskIdFromPathname(pathname)` ≠ アクティブ activeTabId なら panes 側へ冪等反映
- 自動クローズ後も同じ同期経路で URL を追従させる（panes[0] の activeTabId が繰り上がったら replaceState）
- ホスト有効判定: `splitHostEnabled = pathname === "/" || pathname.startsWith("/task/")`。無効（Home/settings）のときは Host が null を返すだけで state は保持（リセット処理なし。SSE は生存するためリスク節参照）
- md フォールバック: `matchMedia("(min-width: 768px)")` を監視。未満では 1 ペイン URL タスクのみに強制（localStorage 復元は行わない）
- status map: `reportStatus(taskId, status)` で TaskView の SSE snapshot を受け取り `Map<taskId, TaskStatus>` を保持。TaskTabs のバッジ源（Phase 3）。closeTab 時に当該 taskId を map から除去
- 自動クローズ: `webui:tasks-changed` を購読し、`GET /api/tasks` の ID 集合に含まれないタブを全ペインから closeTab（削除=アーカイブ反映）
- localStorage 復元: mount 後に `loadTaskPanes()` → 仕様 §5 の復元順序で `replace`

### AppShell / Host

- `AppShellInner` の `<section>` 内を `<TaskPanesProvider>` で囲み、children の代わりに `<TaskPanesHost />` を描く（task path のときのみ内容を出す）
- `TaskPanesHost`: layout tree を再帰描画し、各 split node の orientation に応じた flex と局所リサイズハンドルを配置する。4 ペインでも 2x2 grid へ自動固定しない
  - TaskView は `next/dynamic(..., { ssr: false })` で読む（本家 SplitTaskView と同じ loading プレースホルダ付き）
  - **Phase 2 時点は 1 ペイン × 1 タブのみ動かし、現行 `/task/[id]` と見た目同等であることを確認**
- `page.tsx`: `return null`（URL 初期化は provider の pathname 監視が担う。SSR 一瞬分は dynamic loading 表示で埋まる）

**検証**: typecheck、既存 vitest 全実行、手動で `/task/[id]` が現行どおり表示されること

---

## Phase 3: `TaskTabs` UI + hidden mount + status バッジ

**ファイル**: 新規 `web/src/components/task/TaskTabs.tsx`、`web/src/components/task/TaskPanesHost.tsx`、`web/src/components/task/TaskView.tsx`

- `TaskTabs`: タブバー 1 本
  - props: `pane`, `active`, `statuses`, コールバック群（activate/close/reorder/move/addPane/onClosePane）
  - タブ: title（`...` 省略 + hover フルタイトル）、status バッジ（working = Loader2 スピン / error = 赤点）、`×` ボタン
  - HTML5 DnD: dragstart で `TASK_DRAG_MIME` + taskId、dragover/drop で reorder（同ペイン）/ move（他ペイン）
  - 右端 `+` = `addPane`（最後のペインのみ、`MAX_PANES` 未満のとき）
  - ペイン全体へのドロップもタブバー扱い（空ペインに入れるため）
- hidden mount: `TaskPanesHost` が各ペイン内で `pane.tabs.map` ですべての TaskView を render、アクティブ以外に `hidden` クラス。`key={taskId}` でインスタンス維持
- `TaskView` 変更:
  - Props 追加: `active: boolean`（非アクティブ時 `hidden` を付与）、`reportStatus` 呼び出し用の `onStatus?: (status) => void`
  - SSE snapshot handler 内で `onStatus?.(payload.task?.status ?? ...)` を呼ぶ（数行）
  - `MobileMenuButton` 以外のヘッダー要素は現状維持。ペイン境界との兼ね合いで `border-l` 等は Host 側で付与

**検証**: typecheck、vitest 全実行、手動で複数タブ開閉切替・バッジ即時反映（working 中タスクを裏で開いてスピンが出ること）

---

## Phase 4: DnD 全体接続（Sidebar + AppShell）

**ファイル**: `web/src/components/shell/Sidebar.tsx`、`web/src/components/shell/AppShell.tsx`、新規 `web/src/lib/task-drag.ts`

- `web/src/lib/task-drag.ts`: `TASK_DRAG_MIME = "application/x-leafcodepi-task"` と get/set ヘルパ（本家 `lib/task-drag.ts` と同じ小さな形）
- Sidebar:
  - タスク行（プロジェクト配下 + アーカイブ外一覧）に `draggable` + dragstart で MIME セット。プロジェクト並び替えと干渉しないようタスク行のみ draggable
  - アクティブハイライト: `pathname 由来の activeTaskId` を `useTaskPanes().activeTaskId` に置換（自動展開ロジック L544 も同様）
  - タスク削除（アーカイブ）アクション後に provider 自動クローズが走るため追加コードなし（Phase 2 の機構が担当）
- AppShell: dragstart を捕捉して `draggingTaskId` state を保持し、ドラッグ中は各ペインにドロップ可能であることを示すハイライト（枠線 or オーバーレイ）。md 未満では何もしない

**検証**: typecheck、vitest 全実行、手動でサイドバー→ペイン DnD・ペイン間移動・空ペイン追加→ドロップ

---

## Phase 5: 統合・回帰

- `npm --prefix web run typecheck`
- `npm --prefix web test`（全 vitest）
- `npm test`（web + host）
- 手動確認リスト:
  1. 1 ペイン × 1 タブ = 現行同等（タブバー非表示）
  2. 複数タブ開く → 切替・閉じる・並び替え・Composer テキスト保持
  3. 2〜4 ペイン分割・端ドロップごとの局所方向（4 ペインでも 2x2 固定なし）
  4. リロードで構成復元・直リンク (`/task/[id]`) で URL 優先
  5. Home ↔ task 往復で panes が保持され、戻るとそのまま再表示。エラーなし
  6. working 中タスクのバッジが裏タブでも更新される
  7. タスク削除で該当タブが全ペインから消える
  8. md 幅未満で単一表示フォールバック

---

## リスク

1. **20 EventSource**: 最大 4×5 の TaskView が常駐。BFF 内 harness 配信なので 1 接続あたりは軽いが、**Home/settings 表示中も接続が生存する**（panes 保持方式のため）。問題が出たら「Home 遷移時に SSE を一時停止」or「タブ総数上限 10」へ緩和を検討
2. **replaceState と usePathname の整合**: Next.js の replaceState 対応は App Router 公式だが、pathname 監視 effect との二重同期で不整合が出たら監視条件を見直す（冪等 set で済む設計にしてある）
3. **SSR 白画面**: `ssr: false` の dynamic import のため初回一瞬ローディング表示。本家と同じ許容
4. **コンポーネントテスト不在**: Testing Library 未導入のため UI 分岐は model 層テスト + 手動確認で担保。導入する場合は別タスク

## コミット戦略

| Phase | トピック | コミットメッセージ |
| --- | --- | --- |
| 1 | model 層 | `TaskView タブ機能: タブ・ペイン model と永続化を追加` |
| 2 | Provider + 組込 | `TaskView タブ機能: TaskPanesContext と AppShell 組込を追加` |
| 3 | タブ UI | `TaskView タブ機能: タブバー・hidden mount・status バッジを実装` |
| 4 | DnD | `TaskView タブ機能: サイドバーからのタブ DnD と N ペイン操作を実装` |
| 5 | 統合 | `TaskView タブ機能: 全体統合と回帰確認` |

設計文書自体（この docs 追加）は実装開始前に先行コミット済み。
