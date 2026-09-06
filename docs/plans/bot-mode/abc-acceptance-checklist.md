# Phase A/B/C 手動受け入れチェックリスト（ドラフト）

## 適用範囲
- Phase A: リサーチャー（Researcher）ongoing の基盤確認。Bot 1:1、SOUL/skills/extraRoots、routine の安全な入口と失敗表示を確認する。
- Phase B: ルーム実用化。メンション／全員応答と履歴・並行性を確認する。
- Phase C: Grok 寄せ UI 第2弾。Bot/room の見つけやすさ、プロフィール、設定、応答状態を確認する。
- Computer/Docker/noVNC、Bot↔Bot 無制限 relay、Goal Loop 統合は対象外（`BOT_MODE_BRIEF.md`, `TASK_02_rooms.md`, `IMPROVEMENT_PLAN.md`）。

## 0. 準備
1. LeafCodePi を通常の Windows 起動手順で起動し、`/` が開くことを確認する。
2. Code モードで既存 project/task を 1 件開き、既存の送信・ツール実行・停止ができることを先に記録する。
3. サイドバーの `[Code] | [Bot]` を Bot に切り替え、リロードして Bot モードが維持されることを確認する。

## Phase A — Researcher ongoing / Bot foundation
4. Bot 一覧から「リサーチャー」（なければ同名の新規 Bot）を作成。Bot home に `config.json`、`SOUL.md`、`workspace/` が生成されることを確認する。
5. `/bots/<id>` で SOUL を変更・保存し、次の質問への口調/役割反映を確認する。1:1 の履歴、ストリーム中表示、停止、permission prompt が機能することを確認する。
6. Bot のモデル・思考レベルを変更し、次回応答に使われることを確認する。Code task の model/agent 設定に副作用がないことを確認する。
7. Bot 設定で skills を `inherit` のまま確認し、include/exclude の保存・再読込、追加絶対 path (`extraRoots`) の追加/削除を確認する。Computer 隔離を期待しない。
8. Composer の「ルーティンを作成」から名前・prompt・`0 * * * *` 等の 5 分以上の cron を入力し、確認カードから保存する。空欄・不正 cron・1 分間隔が拒否されることを確認する。
9. 保存後に routine の有効/無効、削除、「今すぐ実行」を確認する。失敗を 3 回相当発生させた場合に failureCount 表示と自動無効化が出ることを確認する。アプリ終了中は cron が動かない仕様を確認する。
10. Code に戻り、元の task が履歴・ツール・SSE を含めて壊れていないことを再確認する。

## Phase B — ルーム実用化
11. Bot モードの「ルーム」から room を作成し、Bot A/B を member に追加・解除する。再読込後も room 名と member allowlist が残ることを確認する。
12. メンションなしで `hello` を送信し、Bot が応答しないことを確認する（user message のみ）。
13. `@Bot A` を送信し、A だけが応答すること、B の response が作られないことを確認する。候補 UI、選択、表示上の mention highlight も確認する。
14. 「部屋に聞く」または `@everyone` を使い、enabled な全 member が個別 assistant message を返すことを確認する。片方の failure が他方を消さないことを確認する。
15. 同じ Bot に rapid な 2 prompt、別 room への同時 prompt を送り、返信が取り違えられないことを確認する。room reply が 1:1 履歴へ混ざらないことも確認する。
16. room SSE を開いたまま返信を受け、別タブ/reconnect 後に timeline が復元されることを確認する。room を削除したとき関連 room task が残らないことを確認する。
17. Bot からの自動 handoff/relay UI が存在せず、`fromBot` 相当の relay request が拒否されることを確認する。これは Phase B の合格条件（relay は既定 off）。

## Phase C — Grok 寄せ UI 第2弾（Computer なし）
18. Sidebar の Bot/room filter、検索、最終メッセージ要約、相対時刻、空状態を確認し、Bot/room/task の入口を混同しないことを確認する。
19. Bot の avatar/color/image、名前、SOUL、model/thinking、skills、extraRoots が設定パネルで読みやすく、保存後に再読込して一致することを確認する。
20. Bot/room header、message bubble、working/error/done、permission prompt、停止ボタンを狭い画面幅でも確認する。日本語ラベルと focus/keyboard 操作（Enter、Shift+Enter、mention候補の上下/Enter/Escape）を確認する。
21. Routine の作成確認カード、failure notice、manual run、toggle/delete が 1:1 画面から見つけやすいことを確認する。Grok 的な会議自動化や Bot 自律 relay が追加されていないことを確認する。
22. 最終回帰として Code ↔ Bot ↔ room を往復し、リロード・SSE reconnect・host/web UI restart 後に Code task、Bot 1:1、room timeline の相互混線がないことを確認する。

## 記録フォーマット
各項目に Pass/Fail、日時、URL、Bot/room ID、再現 prompt、スクリーンショット、ログ（秘密情報なし）、再現回数を記録する。Fail は feature 実装へ直行せず、まず既存 WIP/dirty file と SSE/環境条件を併記する。
