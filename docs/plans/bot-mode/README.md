# LeafCodePi Bot モード — ハーネス指示書セット

LeafCodePi に Bot モードを追加するための指示書です。

## ファイル

| ファイル | 内容 |
|---|---|
| [BOT_MODE_BRIEF.md](./BOT_MODE_BRIEF.md) | 全体設計・制約（全 TASK 共通） |
| [TASK_01_bot_skeleton.md](./TASK_01_bot_skeleton.md) | **最初に振る** — Bot 1:1 MVP |
| [TASK_02_rooms.md](./TASK_02_rooms.md) | ルーム v1 |
| [TASK_03_routines.md](./TASK_03_routines.md) | ルーティン v1 |

## ハーネスへの渡し方

1. 作業ディレクトリを LeafCodePi リポジトリ根にする
2. 最初のプロンプト例:

```
@BOT_MODE_BRIEF.md と @TASK_01_bot_skeleton.md を読め。
BRIEF の制約を守り、TASK_01 だけ実装せよ。TASK_02/03 は実装するな。
完了したら TASK_01 の報告フォーマットで書け。
```

3. TASK_01 受け入れ後に TASK_02 または TASK_03 を同様に振る

## 推奨順序

`01 → 02 または 03 → 残り →（将来）Computer 隔離`
