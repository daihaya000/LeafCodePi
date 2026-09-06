# Bot↔Bot リレー調査メモ（LeafCodePi / 2026-09-06）

## 結論
現行のルームは「ユーザー発言をメンション／全員指定に応じて各 Bot の独立セッションへ配る」実装であり、Bot が別 Bot に発言を送る relay は存在しない。これは `BOT_MODE_BRIEF.md` / `TASK_02_rooms.md` の「Bot↔Bot リレー既定オフ」と一致する。Grok Bot MTG room のような、Bot の返答を次の Bot が受けて会話を継続する会議型挙動は未提供である。

## 今あるもの
- ルーム永続化: `web/src/lib/rooms.ts` の `createRoom/listRooms/patchRoom/deleteRoom`。`{dataDir}/bots/rooms/<roomId>.json` に allowlist (`members`) と timeline を保存。
- ルーティング: `botsForRoomPrompt()` が enabled な member だけを候補にし、`@BotName` / `@botId` のみ指定なら該当 Bot、`@everyone/@all/@here/@channel` または UI の broadcast なら全員、メンションなしなら空配列。
- 実行分離: `roomBotTaskId()` は `bot:<botId>:room:<roomId>` を生成し、`ensureRoomBotTask()` で 1:1 (`bot:<botId>`) と別の Pi task/session を作る。各 Bot の cwd は Bot home の workspace のまま。
- API/UI: `web/src/app/api/bots/rooms/[id]/prompt/route.ts`、`RoomView.tsx`、room events SSE。各返信は room timeline に assistant message として書き戻される。
- 明示的な遮断: room prompt API は `fromBot === true` を 400 (`Bot-to-bot relay is disabled`) で拒否。`TASK_02_rooms.md` の relay/handoff UI/shared volume 除外も現状どおり。
- 既存 subagents は Code task 内の `pi-subagents`（`web/src/lib/agents.ts`, `harness.ts`, `subagent-runs.ts`）であり、Bot room messaging の代替 API ではない。`sendToAgent` 相当の room-facing symbol は確認できない。

## MTG room との差分／ギャップ
1. assistant message は表示用の永続 timeline に留まり、別 Bot の prompt/input へ自動変換されない。
2. relay の source/destination、返信相関、hop/loop 防止、最大ターン、重複排除、停止・再開・監査記録がない。
3. `roomBotRuns` は process-local Map。再起動で in-flight 実行の追跡は失われ、JSON に `working` が残っても再配信/reconcile はしない。
4. EventEmitter/SSE の購読も process-local。複数 web worker/process 間の即時配信は保証しない。
5. 現在の `fromBot` はクライアント入力で偽装できるかどうかを認証で判定する仕組みではなく、単なる opt-in relay の遮断である（単一ユーザー前提の現状）。

## 将来 Phase の最小 surface（実装は今回しない）
- 明示的な server-only `relayRoomMessage({roomId, sourceBotId, targetBotIds, text, correlationId, hop, maxHops})`。ユーザー投稿経路とは分離し、既定 off、room/bot allowlist と permission gate を必須化。
- relay envelope を timeline に保存（source/target, parentMessageId, correlationId, hop, status, error, createdAt）。idempotency key と per-room/per-bot queue を持ち、最大 hop/turn と timeout で loop を止める。
- dispatcher は「受信した Bot の返答を同室へ再投入」ではなく、明示的に target を指定した一方向 handoff から開始。人間承認、停止、監査表示を UI に置く。
- 再起動時は `working` envelope を unknown/failed に reconcile し、無言の再送をしない。共有プロセスで使うなら EventEmitter ではなく durable queue/store が必要。

## 参照テスト
`web/src/lib/rooms.test.ts` は mention/no-mention/broadcast、room task 分離を検証。`web/src/app/api/bots/rooms/[id]/prompt/route.test.ts` は rapid prompt、parallel rooms、failure recovery、SSE、`fromBot` 拒否を検証するが、Bot→Bot relay の test は存在しない。
