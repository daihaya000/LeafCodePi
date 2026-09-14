# Bot間通信（Room外）— intercom ブリッジ計画

**更新:** リサちゃん（調査）／指揮はプラちゃん（2026-09-14）  
**状態:** Phase D 実装済み（A〜Cは master マージ済み。E+ は別GO）  
**方針:** Roomリレーは会話ターン用のまま据え置き。Grok風のBot同士1:1は既存 `extensions/leafcode-intercom` の**型・輸送**を流用し、宛先を **Bot id** にブリッジする。将来拡張のフックを先に定義し、Phaseで段階導入する。

---

## 1. いまあるもの / ないもの

| ある | ない |
|---|---|
| Room handoff / リレー（会話フロア・暗黙@handoff） | Room外の名前付きBot同士DM |
| Piセッション間 intercom（同マシンIPC、list/send/ask/reply/cancel/supersede） | Bot名簿・永続メールボックス・1:1受信UIへの接続 |
| Botツール名に `intercom`（しばしばallowlist外） | なりすまし防止・深さ上限をBot間DMに載せた完成形 |
| Room深さ上限・opaque envelope・二重発火分離の先例 | クロスマシン／クロスアカウントDM |

---

## 2. 採用案と非採用

**採用:** intercom → Bot名簿ブリッジ  
**非採用:** Roomリレーをフロア外メールに流用（会話ターン前提で無理が出る）

### コア契約（全Phase共通・壊さない）

1. **宛先は Bot id のみ**（session名直打ち禁止。内部で `stableId = botId` にマップ）
2. **fromBot 詐称不可**（送信者は実行中タスク／サーバー導出のみ）
3. **深さ／ループ上限**（Roomリレー相当。同一往復の再入場防止）
4. **Room二重発火なし**（Roomターン中の本文@は現行暗黙handoffのみ。DM経路は起動しない）
5. **権限なし送信拒否**（tool allowlist / Bot設定の両方）
6. **メッセージ契約はバージョン付き**（後続Phaseでフィールド追加しても旧受信機が壊れない）

---

## 3. 拡張フック（将来盛り込み・いま実装しないものも枠だけ定義）

| フック | 用途 | 導入Phase目安 |
|---|---|---|
| `v` メッセージスキーマ版 | 添付・スレッド・取消を後付け | A〜 |
| `conversationId` / `replyTo` | ask/reply スレッド | B |
| `mailbox` 永続ストア | 再起動後の未読 | B |
| `presence`（online/busy/offline） | 宛先可否のUI・ask失敗理由 | C |
| `attachments[]` | 画像／ファイル（Room添付方針と揃える） | C |
| `cancel` / `supersedes` / `retryOf` | intercom既存意味論をBot idへ橋渡し | C |
| `confirmSend` | 人間承認付き送信 | C |
| `scopeId`（workspace／プロジェクト） | 無関係Bot間の混線防止 | D |
| `fanout`（複数Bot） | ガード付き一斉通知（既定オフ） | D |
| `wakeOnDm` → Routine / 外部イベント | DM受信でcron外起動 | E（別GO） |
| リモートブローカー | クロスマシン | F（別設計） |
| Computer連携 | 箱プレビューからの委譲 | 対象外（Computer計画と分離） |

---

## 4. Phase計画

### Phase A — MVPブリッジ（最小で動く）

**ゴール:** 常駐中のBot同士が Bot id 宛に send でき、1:1に最小受信UIが出る。

- Bot id ↔ 実行中セッションのマップ（未常駐は明示エラー）
- `send` のみ（askは次Phaseでも可だが、Aではsend優先）
- コア契約1〜6を満たすサーバー側ガード
- Bot設定: intercom opt-in（または明示的な既定ON方針を受け入れで確定）
- UI最小（デザ合意）: 1:1受信箱／未読ドット／「誰から何」1行。Room UIと混ぜない
- 受け入れ: デバ4点（Bot idのみ／なりすまし不可／深さ・ループ／Room二重発火なし）

**Done:** 2 Bot間で往復sendが再現でき、Room会話の@handoffと経路が分離されている。

### Phase B — 永続メールボックス＋ask/reply

**ゴール:** 再起動後も未読が残り、質問待ち（ask）がツール結果として返る。

- ディスク永続mailbox（Bot home配下など。ブローカー再起動に耐える）
- `ask` / `reply` / `pending` をBot id宛に
- 未読のサーバー側記録（localStorageのみに依存しない）
- 切断中の名前付きBotへのキュー（intercomのmailbox概念をBot idへ）

**Done:** 再起動後に未読が残り、askのタイムアウト／replyが受け入れテストで固定される。

### Phase C — 運用感（Grok DM感の肉付け）

**ゴール:** 誤送信しにくく、忙しい相手にも安全に届く。

- presence表示（online/busy/offline）
- 添付（方針はRoom添付と揃える。サイズ／MIME制限）
- `cancel` / `supersedes` / `confirmSend`
- 受信時の通知トグル連携（既存Bot通知設定）
- 理由／診断メタ（messageId、配送状態）のデバッグ表示は折りたたみ

**Done:** 忙殺中のBotへのsteering配送と、取消／差し替えがデモ可能。

### Phase D — スコープと協調パターン

**ゴール:** 無関係Botの混線を防ぎ、限定的な一斉連絡を可能にする。

- `scopeId`（例: 同一workspace／プロジェクト）で見える宛先を制限
- `list` / `list-cwd` 相当を「同スコープのBot名簿」に
- ガード付きfanout（深さ・人数・権限。既定オフ）
- leafcode-intercom skillのBot向けパターン文書

**実装:** Bot設定 `intercomScopeId`（空欄=`default`）で名簿/send/ask/fanoutを隔離。`list` と `list-cwd`（任意 `cwd` は extraRoot/workspace 一致）は同スコープのみ。`fanout` は `intercomFanoutEnabled` 明示opt-in、最大8件、受信fanoutの再放送禁止（`MAX_BOT_INTERCOM_FANOUT_DEPTH = 0`）、Roomターン拒否。メッセージ `v: 1` に任意 `scopeId` / `fanout` / `fanoutDepth`。

**Done:** スコープ外Botへはlistにもsendにも出ない。fanoutは明示opt-inのみ。

### Phase E — ルーティン／外部イベント連携（別GO必須）

**ゴール:** DMをトリガにして常駐Botが動く（ただしルーティン本線と同時実装しない）。

- `wakeOnDm` ポリシー（常に起動／未読のみ／never）
- 外部チャネル（Slack等）からのinboundは **別計画**。本ブリッジの上に載せるならアダプタ境界だけ先に定義
- Roomリレー・Goal Loop・Routineスケジューラと名前空間分離

**Done:** 設計上の境界がドキュメントとテストで固定。実装はルーティン計画のGO後。

### Phase F — クロスマシン（遠未来・メモ）

**ゴール枠のみ:** リモートブローカー、認証、TLS、アカウント境界。  
いまは実装しない。同マシンIPC前提を崩す変更はFまで禁止。

---

## 5. 流用するもの / 新規

### 流用（intercom）

- list / send / ask / reply / pending / cancel / supersede の意味論
- 安定ID・スコープの考え方
- 同マシンIPCブローカー、busy時steering

### 新規

1. Bot id ↔ セッションマップ（＋常駐ライフサイクル）
2. バージョン付きBot DMメッセージ契約
3. 永続mailbox（Phase B）
4. 1:1受信UI（Roomと分離）
5. コア契約の受け入れテスト一式
6. Room経路との相互排他ガード

---

## 6. UI（Phase別）

| Phase | UI |
|---|---|
| A | 受信箱・未読ドット・1行プレビュー |
| B | スレッド／ask待ち表示 |
| C | presence・添付・確認ダイアログ・通知 |
| D | スコープ付き宛先（list / list-cwd が同スコープ名簿。設定にスコープと一斉送信opt-in） |
| E+ | トリガ設定（wakeOnDm） |

---

## 7. 受け入れ（実装時）

### 全Phase共通（デバ4点）

1. 宛先は Bot id のみ  
2. なりすまし不可  
3. 深さ／ループ上限  
4. Room外1:1とRoomリレーが二重発火しない  

### Phase追加観点（例）

- B: 再起動後未読残存、ask timeout 明示  
- C: cancel/supersede の同一sender-receiver制約  
- D: スコープ外へのsendが拒否される  

---

## 8. やらないこと

- Computer / Docker / noVNC（別計画）
- Roomリレー仕様の変更・置換
- Phase Aでクロスマシンや外部Slack直結
- ルーティン／外部イベント本線との同時実装（Eは別GO）
- 全面キーワード化やAuto本体の巻き込み

---

## 9. 依存と順序

```
A（MVP）→ B（永続+ask）→ C（運用感）→ D（スコープ）
                ↘ E（Routine連携・別GO）
F（リモート）は独立・最後
```

ルーティン／外部イベント本線とは **同時に走らせない**。Eに入る前にA〜Cが安定していること。

---

## 10. 次アクション

1. 大ちゃん: 本Phase計画の合意（特にAのopt-in既定とEの後回し）
2. 合意後の実装GOで Phase A のみ切る（プロ実装 → デバ4点 → デザ受信箱）
3. B以降はAの誤爆／運用ログを見てから切る
