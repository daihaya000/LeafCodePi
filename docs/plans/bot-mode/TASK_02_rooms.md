# TASK_02 — ルーム v1（メンション応答）

親ドキュメント: `BOT_MODE_BRIEF.md`  
**前提:** TASK_01 完了済み。  
**このタスクだけ実装する。** ルーティン・Computer は実装しない。

---

## 目的

Bot モードにグループチャット（ルーム）を追加する。

- ルーム作成・メンバー（Bot）管理
- ユーザー発言は **メンションされた Bot のみ** が応答
- `@everyone` または同等の「部屋に聞く」で全員応答
- Bot↔Bot リレーは既定オフ（実装しない／ガードする）

---

## 必須

1. サイドバー Bot モードに「ルーム」セクション
2. ルート例: `/bots/rooms/[roomId]`（既存慣例に合わせてよい）
3. 永続化: `{dataDir}/bots/rooms/<roomId>.json` または同等
4. メンバーは botId の allowlist
5. タイムラインは 1:1 とストア共有できる設計が望ましい
6. 各 Bot は自分のホーム cwd のまま（shared volume は作らない）
7. テスト + Code/Bot 1:1 回帰を壊さない

## 含めてはいけない

ルーティン、chief 自動要約、Bot↔Bot ハンドオフ UI、Docker computer、shared volume

## 受け入れ基準

- [ ] ルームを作り Bot を追加できる
- [ ] メンションなしでは Bot が動かない（または仕様どおり無視）
- [ ] `@BotName` でその Bot だけが応答する
- [ ] `@everyone`（または明示 UI）でメンバー全員が応答する
- [ ] 1:1 Bot と Code モードが壊れていない
