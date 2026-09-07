# Room改善計画（確定版）

親ドキュメント: `BOT_MODE_BRIEF.md` / `TASK_02_rooms.md`
確定日: 2026-09-08（未決事項を質問UIで確定、GrokBot再現観点の最終チェック済み）

## 確定した決定

| 項目 | 決定 |
| --- | --- |
| R3 RoomのCodeセッション | 会話単位で新規。次の依頼から `start` が新セッションを作る |
| R6 複数ワーカー | Room発言にファイルロックを実装（ワーカー間共有前提の保護） |
| Code自動承認 | Room設定で常時（既定オフ、有効化はWebUIトークン必須） |
| 巻き戻し | Room履歴のみ（該当発言以降を削除して入力欄へ。Botセッションは触らない） |
| 旧Bot↔Botリレー | 削除。会話ランタイムに統一（depth/replay系テストも整理） |

## 再レビューで繰り込んだ干渉修正

1. R1の判定変更は起動時のRoom排他を壊し得るため、判定を2種に分離（下記0-1）。
2. ストリーミング非永続化はR6決定と矛盾するため中止。現行のファイル書き込み＋400msを維持。
3. 巻き戻しは当該会話の未決着Code要求の取り消しを含む（削除済み文脈への報告到着防止）。

## フェーズ0: 欠陥修正

1. **R1＋排他の分離** — `bot-code-relay.ts:93-95,179`、`room-runtime.ts:122-123`
   - `pendingRoomCodeRequestForRoom(roomId)`（全要求・起動時の排他用）と
     `pendingRoomCodeRequestForTurn(roomId, requestId)`（同一 `conversation.requestId`・会話待機用）を新設。
   - 会話側は後者を使用。旧要求の `ready` 残骸で新規会話が沈黙しない。
2. **R2 生存判定付き掃除** — `room-runtime.ts:91-97`
   - `settleStaleRoomTurns` に `roomBotRuns` 在否＋ `getTaskDetail(roomBotTaskId).status === "working"` を除外条件へ追加。
   - テスト: 「10分前かつ実行中」を掃除しない。
3. **R5 語境界付きNEXT解決** — `room-conversation.ts:46-48`。`NEXT about ...` は受け渡さない。
4. **R10 transcript要求未検出のフォールバック** — `room-conversation.ts:54`。`findIndex === -1` なら直近30件。
5. **R9 失敗ターンの注記化** — `room-conversation.ts:55`。`{ speaker: "system" }` の短い注記を1件だけ履歴へ（Bot発言扱いにしない）。
6. **R4 承認の先行チェック** — `bot-code-relay.ts:160-165`。承認前に排他チェック（自動承認の有無も含む）。
7. **R3 会話単位のCodeセッション** — `bot-code-relay.ts:99-101,178`
   - `linkedCodeTaskId` を「同一 `conversation.requestId` のメッセージ」に限定。
   - 同一会話内の `start` は継続案内、別会話では新規 `start` が成功。Room全体の実行排他（0-1）は維持。
8. **R8 終了理由の明示** — `room-runtime.ts:116-135`。`RoomDto.lastOutcome`（code-wait / members / turns / repeat / done）を設定しUIフッターに表示。モデルへ再投入しない。

## フェーズ1: Code実行中の可観測性・操作

9. **Code進捗のRoom表示** — `room-runtime.ts` に `streamRoomCodeProgress`。`subscribeTask` で `codeTaskId` を追跡し、ツール名＋対象のみを `RoomMessage.codeActivity` へ400ms間隔で反映（本文は流さない）。表示は `RoomView.tsx` のCodeバッジ行。`delivered/cancelled` で購読解除（解除テスト含む）。
10. **RoomからCode停止** — 新規 `app/api/bots/rooms/[id]/code/route.ts`（POST `abort`）。`pendingRoomCodeRequestForRoom` で特定し `abortTask`。中断は `resumeRoomAfterCode` の自動継続条件に該当しない。
11. **待機・確認待ちの在室表示（G2）** — SSEの `RoomAttention`（`events/route.ts:26-31` で配信済み）を `RoomView` の在室状態と統合し、アバターを「応答中／確認待ち」に区分。待機理由は0-8の `lastOutcome` に統合。

## フェーズ2: 停止・排他の完全化

12. **`/stop` を実行中ターンへ** — `prompt/route.ts:38`。`working` のRoom Botタスクを `abortTask`（Code対象外）。
13. **`@here` ファンアウト制限** — `prompt/route.ts:48-49`。同時4、超過は順次（メンション先が実行されない状態を作らない）。
14. **Room発言のファイルロック** — `room-runtime.ts:8-10,38`。`withBotCodeSessionLock`（`bot-code-session-lock.ts:63-100`）を `bot:<id>:room:<roomId>` 単位で `runRoomBot` 実行区間に適用。
15. **作業中への追撃指示（G1）** — 新規ユーザー指示の到着時、最後の話者が生成中なら `promptTask` の `streamingBehavior: "steer"`（`harness.ts:5532,5552-5566`）で同一ターンへ差し込む。steer不能なら従来の失効＋新会話。`/stop` と併存（stopはsteerせず中断）。

## フェーズ3: I/O とスケール

16. **履歴の上限と退避** — `rooms.ts:210-221`。直近500件超を `rooms/<id>/history-*.jsonl` へ退避。`conversation.requestId` 相関と `code-report:<id>` 冪等性（`room-runtime.ts:151`）を維持。
17. **SSE差分化** — `events/route.ts:17-31`。比較は `room.updatedAt`＋attentionハッシュ、送信は直近N件＋差分。
    - ストリーミング非永続化は**中止**（R6決定との矛盾）。

## フェーズ4: 権限・機能パリティ

18. **Room設定でのCode自動承認** — `RoomDto.codeAutoApprove`（既定false）＋ `rooms/[id]/route.ts` PATCH。認可は `botRelayEnabled` と同じWebUIトークン必須。`bot-code-relay.ts:162-163` で有効なら `deps.approve` をスキップ（記録はresultに含める）。Bot側から設定変更は不可。
19. **Roomの添付画像** — `RoomMessage.images`（data URL）追加、`RoomView` の `BotComposer` に `attachments` を配線、`promptTask` の `images` へ渡す。
20. **巻き戻し（Room履歴のみ）** — 新規 `app/api/bots/rooms/[id]/revert/route.ts`（POST `{ messageId }`）
    - 該当ユーザー発言以降（自身を含む）の `room.messages` を削除し `{ text }` を返す。
    - 当該会話の未決着Code要求を `cancelled` にする。実行中ターンは既存の失効経路で自然停止。Botセッションは触らない。
21. **Roomの通知・未読** — Room単位の通知設定と完了・承認待ち通知。

## フェーズ5: 整理

22. **旧リレー削除** — `rooms.ts:78-121`、`prompt/route.ts:19-31`、`MAX_ROOM_RELAY_DEPTH`、relay stateファイル、`RoomMessage` の relay 専用フィールド（`sourceBotId/relayTurnId/relayDepth/relayParentMessageId`）。
    - `transcript`（`room-conversation.ts:56`）と `roomContext`（`bot-code-relay.ts:88`）の `sourceBotId` 判定を撤去し、要求ラベルは `User request` 固定。
    - `rooms.test.ts` の depth/replay/claims 系を削除、`prompt/route.test.ts` のリレー系テストを削除。`botRelayEnabled` PATCH認可のテストは `codeAutoApprove` 用に転用。
    - ディスク上の旧フィールドは `normalizeRoom` が無視するため互換。

## 検証

```text
cd web
npx vitest run src/lib/room-runtime.test.ts src/lib/room-conversation.test.ts src/lib/rooms.test.ts src/lib/pi/bot-code-relay.test.ts "src/app/api/bots/rooms/[id]/prompt/route.test.ts" src/components/bot
npm run typecheck
npx eslint <変更ファイル>
```

- 0-1: 旧要求残骸＋新要求で完走、かつ実行中要求がある新規Code起動は拒否。
- 0-7: 同一会話内 `start` は継続案内、別会話 `start` は新規作成。
- 0-2: 「10分前かつ実行中」が掃除されない。
- 1-10: 停止後に `promptTask` が増えず自動継続しない。
- 2-14: 同一Room Botタスクへの並行 `runRoomBot` が直列化。
- 2-15: 生成中ターンへのsteer後、返答が差し込まれた指示に対応。
- 4-18: 無認可で `codeAutoApprove` を変えられない。有効時は承認ダイアログなしでCodeが起動。
- 4-20: 巻き戻し後に旧会話のCodeが `cancelled` になり報告が届かない。
- 手動一巡回: `/discuss` → 承認（または自動承認）→ 進捗表示 → 長時間ターン中の別送信（反転なし）→ 停止 → 巻き戻し → 再依頼。

## リスク

- 自動承認（4-18）は権限境界の緩和。既定オフ＋トークン必須。有効Roomでは依頼が即Code実行まで進む点を実装報告に明記する。
- 旧リレー削除（5-22）は破壊的変更。`fromBot` 経路を外部が使っていないことが前提。
- ファイルロック（2-14）により、ロック待ちタイムアウト（既定10秒）超過時にRoom発言がエラー確定になる。stale回収（60秒）と合わせ挙動を確認。
- 追撃指示（2-15）は生成中ターンが途中から新指示に従う挙動変更。最小実装＋テストで固定し、違和感があればsteer無効へ戻す。

## GrokBot再現で意図的に外すもの（非目標）

- Computer相当（OS操作・ブラウザ・VM）。実作業は承認付き `code_session` に一本化する思想。
- スレッド・リアクション。Room会話ではフロア制御（ROOM_ACTION＋@名前）で代替。
- クロスアカウント共有Room・レジストリ（grok-bot-roomsの層）。単一ユーザーのローカルAppの範囲外。
- @ルーチン／コネクタ指定、Room横断検索・コマンドパレット、カンバン（GrokBot自身もボード類を導入せず拒否）。
- トークン単位描画、プロセス再起動を跨ぐ会話自動再開（Code報告のみ永続アウトボックスで継続）。

## 任意改善（低コスト時のみ）

- コンポーザの `/` スキル参照補完（1:1と共通化できる場合）。
- グループ名の自動生成・kickoff提案の表示。
- Room内Codeプレビュー（`BotCodeSessionPanel` のRoom版を設定パネルへ）。

## トレードオフの明記（docsへの反映）

- 旧リレー削除後、Bot同士の**フロア外の非同期メッセージングは存在しない**。対話は共有フロアの引き渡し（ROOM_ACTION＋@名前）のみ。将来必要ならRoom専用の「起床」経路として再設計（旧経路の復活はしない）。
- `/stop`＝テキストターン停止、Code停止＝Room内の停止ボタン、という棲み分け。完了済み作業は取り消さない。
