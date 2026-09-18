# n8n公式Skills の取り込み元（vendoring）

`skills/n8n-*-official/` と `skills/using-n8n-skills-official/` は n8n公式リポジトリのコピーです。

- 上流: https://github.com/n8n-io/skills
- 取り込みコミット: `180b841`（Merge pull request #39 from WayneSimpson/feat/opencode-plugin）
- 取り込み日: 2026-09-18
- ライセンス: Apache-2.0（全文は [`n8n-skills-LICENSE.txt`](n8n-skills-LICENSE.txt)）

## 取り込み範囲

- `skills/*-official/` の14ディレクトリ（SKILL.md + references/）のみ
- 上流のプラグインラッパー（`hooks/`、`.claude-plugin/`、`.codex-plugin/`、`.agents/`、`opencode/`）と `README.md` / `CLAUDE.md` は取り込まない

## 改変

- 改行は LF に統一
- `using-n8n-skills-official/SKILL.md` の冒頭に LeafCodePi（Pi ハーネス）向けの読み替え注記を1ブロック追加（Skill tool / hooks が無い環境での read・`mcp` proxy tool の使い方）。他の13スキルは無改変
- 上流原文の行末空白・末尾空行はそのまま保持する（`git diff --check` がこれらの箇所で警告を出す）

## 更新手順

1. 上流を任意のコミットで clone する
2. `skills/*-official/` の14ディレクトリを差し替える（改行を LF に統一）
3. `using-n8n-skills-official/SKILL.md` の冒頭注記を再適用する
4. このファイルのコミットハッシュと日付を更新する
