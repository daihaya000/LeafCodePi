# LeafCodePi メモリ

## 2026-08-23: 協調設定を設定画面の一般タブへ露出

`collaboration.json`（モード、ハートビート、リース TTL、stuck、ask タイムアウト、活動上限、check コマンド）はファイル直編集だけだった。設定 UI の「一般」に協調パネルを追加した。

- `GET`/`PUT` `/api/collaboration/config` が同じバリデーションで読み書きする
- 不正値は保存せず fail-closed（実行時は従来どおり既定の strict）
- 変更は新しいセッションまたはホスト再起動から適用される旨を表示する
- 拡張の無効化スイッチとは別。協調拡張自体は必須のまま

検証: `collaboration-config` と `CollaborationSettings` のテスト。localhost:3011 の一般タブで緩和へ切替→保存し、一時 `LEAFCODE_PI_DATA_DIR` の `collaboration.json` が `mode: "permissive"` になった。

## 2026-08-23: leafcode_edit の CRLF 不一致と SSE heartbeat の closed enqueue

リース確保後の `leafcode_edit` が `oldText must match exactly once.` で連続失敗し、WebUI は `Controller is already closed` を繰り返していた。どちらも実害のある欠陥だった。

### 不具合1: CRLF ファイルに LF の oldText が一致しない

Windows の `SettingsView.tsx` は CRLF（160 行すべて `\r\n`）。エージェントは読取結果どおり LF の複数行 `oldText` を送る。`mutate` は `String.indexOf` の生一致だけだったため、改行を含む置換は必ず失敗する。単一行（改行なし）の最初の編集だけ成功していた。

修正: `applyUniqueTextEdit` で改行を正規化して一意一致を取り、書き戻し時はファイルの多数派 EOL を維持する。

### 不具合2: SSE ping が close 後に enqueue する

タスク/プロバイダログインの SSE が `setInterval` で `controller.enqueue` していた。abort で `close()` したあと、すでにキューに入った timer が `ERR_INVALID_STATE` を投げ、`uncaughtException` になる。`send()` 側だけ try/catch があり ping は無防備だった。

修正: `createSseWriter` で closed フラグ・heartbeat 停止・enqueue 失敗時 cleanup を共通化。両 events ルートがこれを使う。

### 検証

```
npm --prefix web test -- --run src/lib/sse-writer.test.ts src/lib/collaboration-room.test.ts ../extensions/leafcode-collaboration/index.test.ts
```

27 tests passed（sse-writer 3、collaboration-room 21、index 3）。新規: LF oldText × CRLF ファイル、heartbeat after close。

拡張と WebUI の反映には LeafCode セッション再起動が必要。本番は `%LOCALAPPDATA%\leafcode-pi\build\...` のミラーから動く。

## 2026-08-23: leafcode-collaboration 徹底バグハント

reserve 直後 edit 失敗の続き。コード・IPC・再接続・Windows パス・lock を洗い、実害のある残件を直した。

### 今回潰した欠陥

1. **pipe 再接続で旧 socket の close が session を offline にし lease を orphan する**  
   同じ `connectionId` の再 join 後に古い close が `markDisconnected` していた。  
   現行 socket だけ切断扱いし、切断を `operationTail` に載せる。同じ connectionId で join したら orphan を復元する。
2. **再接続が `leave` を送り clean lease を released にする**  
   `connectRuntime` は `disconnect()`（leave なし）を使う。
3. **最後の leave の `setTimeout(close)` が直後の join を殺す**  
   遅延 close は世代番号と「誰か online か」を再確認する。
4. **runtime key が cwd 文字列**  
   trailing slash / サブディレクトリで RoomClient が分裂する。key は sessionId + git `projectKey`。
5. **空・壊れた lock を stale と見なさない**  
   ファイルはあるが parse できない lock を takeover 可能にした。
6. **生きた coordinator の listen 前に即 degraded**  
   IPC 失敗時は短く再試行する。
7. **check/commit の pipe RPC が 5s で切れる**  
   check/commit は `CHECK_TIMEOUT_MS + 10s`。
8. **Git パス大小文字で observed が汚染される**  
   `normalizeGitPath` / `updateLeaseObservation` を `relativeKey` に統一。index 指紋は status の後に取る。
9. **`requireRoom` が degraded 理由を捨てる**  
   `connectError` / `degradedReason` を例外に含める。

### 検証

```
npm --prefix web test -- --run src/lib/collaboration-room.test.ts src/lib/collaboration-config.test.ts src/lib/collaboration-room-status.test.ts ../extensions/leafcode-collaboration/index.test.ts
```

27 tests passed。新規: trailing-slash/subdir cwd、空 lock takeover、同一 connectionId の pipe 再接続。

### 残る制約（仕様または環境）

- dirty/orphaned lease の他セッション takeover は仕様どおり未実装。死んだ agent の dirty path は同じ session の再 reserve が必要
- PID 再利用で lock が生きて見える場合は、再試行後も degraded になり得る
- Windows で git スキャンが稀に `git_state` になるのは並列テスト負荷のフレーク。単体再実行では成功する
- hardlink (`nlink > 1`) は予約・編集できない

## 2026-08-23: leafcode-collaboration が reserve 直後に edit できない

報告: `leafcode_collab reserve` は成功するが、続けて `leafcode_edit` が
`An active lease covering this path is required.` で落ち、作業不能。

### 原因

同じ症状を出す独立した欠陥が2つあった。

1. **ツールごとに RoomClient が分裂する**  
   runtime を `WeakMap<ExtensionContext>`、その後 `WeakMap<sessionManager>` で
   持っていた。Pi は tool call ごとに新しい context / sessionManager を渡し得る。
   そのたびに新しい `connectionId` で join し、既存リースが `orphaned` になる。
   再現テスト: `keeps one room client when tool calls use fresh ExtensionContext objects`
   （sessionManager キーでも、start / reserve / edit / shutdown を別オブジェクトにすると落ちる）。

2. **接続中でも clean lease が 15 秒で切れる**  
   既定 `leaseTtlMs` は 15s。coordinator の timer / heartbeat / status は
   `expireCleanLeases()` するだけで、接続中セッションのリースを更新しない。
   エージェントが reserve 後に 15 秒以上考えると、edit 前に `released` になる。

パスの大文字小文字（`SettingsView.tsx` vs `settingsview.tsx`）は Windows では
`relativeKey` で既に正規化済み。今回の失敗の直接原因ではない。

### 修正

- `extensions/leafcode-collaboration/index.ts`: sessionId + cwd 文字列で runtime を共有
- `extensions/leafcode-collaboration/room.ts`: 接続中セッションの lease を heartbeat / status / timer で更新
- 失敗時は orphaned / 他セッション予約をメッセージで区別する

### 検証

```
npm --prefix web test -- --run src/lib/collaboration-room.test.ts ../extensions/leafcode-collaboration/index.test.ts
```

17 tests passed。

### 残る制約

- coordinator 再起動後の orphaned lease は、同じセッションが `reserve` し直せば回収できる
- hardlink (`nlink > 1`) のファイルは今も予約・編集できない（web-build-mirror は `src/` を copy している）
- 切断後の clean lease は従来どおり TTL で解放する

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

### runtime WeakMap キー（ea1746f、不十分）
- `WeakMap<sessionManager>` では、sessionManager 自体が tool ごとに新しい場合に再発する
- sessionId + cwd の Map に置き換えた（上記 2026-08-23 節）

## 2026-08-23: 協調「競合1件」の解消手段が UI に無かった

バッジとバナーが `leaseConflicts` の件数だけ出し、どのファイルか・どう直すかを示していなかった。`takeover` は Phase 3 未実装で、エージェントの `leafcode_collab release` も clean lease 以外は失敗する。

### 仕様

件数は `invalid` / `orphaned` のファイル予約。切断後に残った予約、または予約後の外部変更。自動では消えない。

### 修正

- GET `/api/collaboration` が衝突の所有者・パス・状態を返す
- タスク画面の警告に説明と「予約を解除」を出した。作業ツリーは残す
- POST `/api/collaboration` `{ action: "discard", leaseId }` が coordinator 経由で orphaned/invalid だけ released にする
- 所有セッションを再開して同じパスを `reserve` すれば従来どおり回収できる

### 検証

```
npx vitest run src/lib/collaboration-room.test.ts src/lib/collaboration-room-status.test.ts src/components/CollaborationStatus.test.tsx
```

28 tests passed。localhost:3011 のホームは回帰なし（このデータディレクトリにはプロジェクトも衝突も無い）。

## 2026-08-23: 協調警告がタスク画面に見えなかった

前回の「予約を解除」はチャットのスクロール領域とバッジの `title` / `aria-label` にしか出ず、件数テキストも画面に無かった。サイドバーのバッジはプロジェクト名ボタンの内側だったので、押すとホームへ飛ぶだけだった。ホームには警告自体が無かった。

### 修正

- バッジを独立ボタンにし、本文に「競合N件」を出す。押すとダイアログで説明と解除
- タスク画面の警告はヘッダー直下に固定。チャットをスクロールしても消えない
- ホームでも選択中プロジェクトの警告を入力欄の上に出す
- 文言は「ファイル予約の競合」。lease という内部語は出さない

### 検証

`CollaborationStatus.test.tsx` 4 tests passed。localhost:3011 でサイドバー「競合1件」→ダイアログ「予約を解除」、ホームのバナー、タスク画面ヘッダー直下のバナーを確認した。

