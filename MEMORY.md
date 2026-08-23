# LeafCodePi メモリ

## 2026-08-23: 巻き戻し「ユーザーメッセージのみ入力欄に戻せます」修正

### 症状
ツール実行後など、ユーザーメッセージの「入力欄に戻す」や undo 巻き戻しで
「ユーザーメッセージのみ入力欄に戻せます」エラーが出る。

### 原因
`snapshotMessages`（`web/src/lib/pi/harness.ts`）が Pi セッション entry id を
`stored[index]` のインデックスで `projectPiMessages` 出力に割り当てていた。
`toolResult` は UI に独立メッセージとして出ない（assistant の tool パートへ merge）ため、
その後の user メッセージの id が `toolResult` entry を指し、
`revertTask` の `entry.message.role !== "user"` チェックで拒否されていた。

### 修正
- `web/src/lib/pi/messages.ts` に `piRawMessageProjectsToUi` /
  `entryIdsForProjectedMessages` を追加
- `snapshotMessages` で project 出力と同じ順序で entry id を割り当て
- `messages.test.ts` に toolResult 挟み込み時の id 整合テストを追加

### 関連 API
- `POST /api/tasks/[id]/revert` — `entryId`（UiMessage.id = セッション entry id）
- `revertTask` / `messageEntryById` in `harness.ts`

## 2026-08-23: leafcode-collaboration 編集ブロック（hardlink + orphaned lease）

### hardlink（11db897）
- `web-build-mirror.mjs` が `web/src/**` を hard link → `nlink>1` で協調編集拒否
- 恒久対策: `src/**` は byte copy（約 1.4MB）。`syncMirror` で既存 link を自動移行

### orphaned lease（f7a3b61）
- `reserve` 成功後の `edit` が `Lease is 'orphaned'` 等で失敗
- 原因: mutate が orphaned を選択、同一 session の reserve が自分の orphaned を conflict、reconnect で connectionId 変化
- 修正: active/dirty のみ mutate、orphaned reclaim、connectionId 安定化、reserve 応答に leaseId
- 手順: `reserve` → 応答の leaseId 確認 → 直後に edit。reconnect 後は再 reserve

### runtime WeakMap キー（続き）
- 症状: reserve 直後の edit が `An active lease covering this path is required`、release は既に `released`
- 原因: `runtimeStates` が `WeakMap<ExtensionContext>` キーで、Pi は tool 呼び出しごとに新しい ctx オブジェクトを渡す。edit 時に別 RoomClient・別 connectionId で join → 直前の lease が orphaned/released
- 修正: `WeakMap<sessionManager>` に変更。reserve→edit 統合テスト追加
