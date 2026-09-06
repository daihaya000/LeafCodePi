# LeafCodePi — Bot モード実装指示書

このドキュメントは、コーディングハーネス（LeafCodePi / Cursor / Claude Code 等）に渡すための実装指示書です。  
**リポジトリ:** https://github.com/daihaya000/LeafCodePi  
**方針:** 別プロダクトを作らず、既存 LeafCodePi に Bot モードを追加する。

---

## 0. 読み方

| ファイル | 用途 |
|---|---|
| 本ファイル `BOT_MODE_BRIEF.md` | 全体設計・制約・用語（常に守る） |
| `TASK_01_bot_skeleton.md` | 最初に振るタスク（Bot 1:1 MVP） |
| 後続 `TASK_02_*.md` / `TASK_03_*.md` | ルーム、ルーティン（別タスクで振る） |

ハーネスは **いま渡された TASK だけ** を実装する。BRIEF の後続フェーズを勝手に実装しない。

---

## 1. ゴール（プロダクト）

LeafCodePi に次を追加する:

1. **Code モード**（既存）— プロジェクト → タスク中心のコーディング UI
2. **Bot モード**（新規）— 名前付き常駐ボット。専用ホーム、1:1 チャット、（後続）ルーム、ルーティン

Pi コアは現状どおり `@earendil-works/pi-coding-agent` の **in-process SDK**。  
Computer / Docker 隔離は **この一連の初期タスクではやらない**。

---

## 2. 用語

| 用語 | 意味 |
|---|---|
| Code モード | 既存のプロジェクト／タスク UI |
| Bot モード | 新規。ボット一覧・1:1・ルーム |
| Bot | 役割・ホーム・設定を持つ常駐エージェント |
| ホーム | ボット専用ディレクトリ。ツール cwd の根 |
| SOUL.md | その Bot の役割・口調・禁止事項 |
| ルーム | Bot モードのグループチャット（ユーザー + 複数 Bot） |
| ルーティン | Bot に紐づくスケジュール起動ジョブ（Goal Loop とは別） |
| subagents | Code／タスク内の委譲。Bot／ルームとは別レイヤ |

---

## 3. やること／やらないこと

### やること（全体ロードマップ）

- A. Bot 1:1 骨格（UI 切替、CRUD、ホーム、チャット、SOUL／スキル継承）
- B. ルーム v1（メンション応答）
- C. ルーティン v1（cron + 作成カード）
- D. 設定に「ボット」タブ（共通既定のみ）

### やらないこと（初期シリーズ全体）

- Docker / 専用 computer / noVNC
- OpenBot の CopilotKit Intelligence / AG-UI 全面導入
- CEL ポリシーエンジンのフル移植
- Code タスク画面への Bot 機能ねじ込み
- プロジェクト一覧とボット一覧の混在
- 全発言の全 Bot 自動配信
- Bot↔Bot 無制限リレー
- AGENTS.md の二重管理、スキルの物理コピー
- Goal Loop をルーティンに統合すること

---

## 4. UI・ルーティング

### モード切替

- サイドバー最上段: セグメント **`[Code] | [Bot]`**
- 最後に選んだモードは `localStorage` に保存
- 設定トグルや Composer 横ドロップダウンでは切り替えない

### ルート

| モード | パス |
|---|---|
| Code | `/` , `/task/[id]` （既存） |
| Bot | `/bots` , `/bots/[id]` |
| ルーム（後続） | `/bots/rooms/[roomId]` または同等 |
| 設定 | `/settings` （両モード共通・入口は一つ） |

### サイドバー（Bot 時）

```
[Code] [Bot]
────────────
ルーム          ← TASK_02 以降
  …
ボット
  <bot name>…
────────────
設定
```

Code 時は現行どおりプロジェクト／タスク。

---

## 5. データモデル

### Bot ホーム（プロジェクトと同型にしない）

```
{dataDir}/bots/<botId>/
  SOUL.md
  MEMORY.md          # 任意。初期は空でも可
  workspace/         # ツールの cwd
  config.json
  routines/          # TASK_03 以降
```

`dataDir` は既存の LeafCodePi データディレクトリ規約に従う  
（Windows `%APPDATA%\leafcode-pi`、Linux/macOS `~/.leafcode-pi`、または `LEAFCODE_PI_DATA_DIR`）。

### `config.json`（最小）

```json
{
  "id": "uuid",
  "name": "リサーチャー",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "model": null,
  "thinkingLevel": null,
  "permissionMode": null,
  "skills": { "mode": "inherit", "include": [], "exclude": [] },
  "extraRoots": [],
  "enabled": true
}
```

- `skills.mode`: `"inherit"` | `"include"` | `"exclude"`（既定 `inherit`）
- `extraRoots`: ホーム外で触ってよい絶対パス（初期は空配列。未実装でもフィールドは用意）
- **初期 MVP では extraRoots 未使用でホーム内のみ**でもよい

### SOUL.md

- Bot 作成時にテンプレートを置く
- システム／エージェント指示として Pi セッションに注入（グローバル AGENTS.md と併用。SOUL が Bot 固有）

### 指示・スキルの優先度

1. グローバル `~/.pi/agent/AGENTS.md`（Code/Bot 共通）
2. 有効スキル（Bot は inherit／include／exclude）
3. プロジェクト AGENTS.md … **Code 専用**（Bot では読まない。初期）
4. Bot `SOUL.md`
5. スレッド／ルームの一時指示（任意・後続可）

---

## 6. 設定画面

- **一つの** `/settings` を維持（Code/Bot でアプリを分けない）
- 既存タブ: エンジン / モデル / エージェント / 拡張
- 追加タブ: **「ボット」** — Bot **共通既定のみ**
  - 例: 新規 Bot の既定 permission、skills 既定 `inherit`、ルーティン上限（TASK_03）
- **Bot 個別**（SOUL、ホーム、スキル allowlist、その Bot のルーティン）は `/bots/[id]` 側
- 「エージェント」タブは既存 subagents 用。Bot 一覧編集には使わない

---

## 7. Pi harness

- 既存 `web/src/lib/pi/harness.ts`（または同等）を拡張
- Bot セッション: `cwd` = `workspace/`、SOUL / スキルを注入
- Windows は既存の powershell 規約を踏襲
- Code と Bot 同時稼働に耐えられるよう session を id で分離
- 認証・モデルは既存設定を再利用

---

## 8. ルーム（概要・TASK_02）

- Bot モード専用。メンションされた Bot のみ応答（`@everyone` または「部屋に聞く」で全員）
- Bot↔Bot リレーは既定オフ。各 Bot は自分のホーム cwd のまま

---

## 9. ルーティン（概要・TASK_03）

- Goal Loop とは別。主入口は会話の確認カード、副入口は `/bots/[id]`
- 保存: `bots/<botId>/routines/<routineId>.json`。v1 は cron・1:1 のみ
- ガード: 最短間隔、最大件数、連続失敗で自動オフ、permission-gate

---

## 10. 実装原則（ハーネス向け）

1. 既存パターン踏襲（Sidebar、TaskView SSE、permission、store、settings）
2. TASK 範囲外を実装しない
3. Code モード回帰を壊さない
4. テスト追加し check / typecheck / lint / test を通す
5. README に Bot モードの短い節（TASK_01 完了時）
6. 秘密をコミットしない

---

## 11. シリーズ完了時の受け入れ

- Code | Bot 切替、Bot 作成・ホーム・1:1 会話・ツール実行
- グローバル AGENTS + SOUL、ルーム（TASK_02）、ルーティン（TASK_03）
- Computer なしで既存 Win/Linux 起動手順で動く

---

## 12. 参考

- 土台は LeafCodePi。第一マイルストーンは TASK_01（Bot 1:1）
