# TASK_01 — Bot モード骨格（1:1 MVP）

親ドキュメント: `BOT_MODE_BRIEF.md`（必ず守る）  
**このタスクだけ実装する。** ルーム・ルーティン・Computer は実装しない。

---

## 目的

LeafCodePi に Bot モードの最小実用版を入れる。

- サイドバーで Code | Bot 切替
- Bot の作成／一覧／削除
- ボット専用ホーム + SOUL.md
- `/bots/[id]` で 1:1 チャット（ストリーム・停止・権限は既存流用）
- グローバル AGENTS.md + SOUL 注入、スキルは `inherit` で可

---

## スコープ（必須）

1. **モード切替 UI** — Sidebar 最上段 `[Code] | [Bot]`。`localStorage` に保存。Bot 時はボット一覧
2. **ルート** — `/bots`（一覧・作成）、`/bots/[id]`（1:1）。既存 `/` `/task/[id]` `/settings` 維持
3. **永続化** — `{dataDir}/bots/<botId>/` に `config.json`、`SOUL.md`、`workspace/`
4. **API** — GET/POST `/api/bots`、GET/PATCH/DELETE `/api/bots/[id]`。チャットは既存 task の prompt/events/abort を壊さず Bot 用に分離
5. **Pi harness** — cwd=`workspace/`、SOUL 注入、skills は inherit 必須。session を `task:` / `bot:` 等でキー分離
6. **1:1 UI** — TaskView / Composer / SSE / permission / abort を再利用。SOUL 簡易編集
7. **設定** — `/settings` に「ボット」タブ（共通既定のプレースホルダ可）。個別 SOUL は置かない
8. **テスト** — ストア／API vitest。check または typecheck+lint+test を通す
9. **README** — Bot モードの短い節

## 含めてはいけない

ルーム、メンション、ルーティン、cron、Docker computer、OpenBot/AG-UI、プロジェクト配下への Bot 紐づけ、スキル allowlist の凝った UI、Goal Loop の変更

---

## 受け入れ基準

- [ ] Code | Bot 切替ができ、リロード後もモードが残る
- [ ] Bot 作成でホーム（SOUL / workspace / config）ができる
- [ ] `/bots/[id]` でストリーム応答し、ツールが `workspace/` 配下で動く
- [ ] SOUL 変更が以降の応答に反映（または再作成後—挙動を明記）
- [ ] Code モードが従来どおり動く
- [ ] 型チェック・lint・追加テストが通る
- [ ] Win powershell / Linux bash の既存規約を壊さない

---

## ヒント

- `Sidebar.tsx`, `AppShell.tsx`, `store.ts`, `pi/harness.ts`, `TaskView.tsx`, `SettingsView.tsx`
- メッセージ永続は dataDir 配下に閉じる

---

## 完了時の報告

1. 変更ファイル一覧（要点）
2. 受け入れ基準のチェック結果
3. 手動確認手順
4. 既知の制限・フォローアップ（TASK_02/03）
5. 残った設計判断があれば一文
