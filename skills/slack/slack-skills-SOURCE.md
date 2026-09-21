# Slack公式Skills の取り込み元（vendoring）

`skills/` 直下の Slack スキル8個は Slack公式リポジトリのコピーです。

- 上流: https://github.com/slackapi/slack-skills-plugin
- 取り込みコミット: `8044341`（feat: support developer sandboxes, free, and paid teams as install targets (#147)）
- 取り込み日: 2026-09-18
- ライセンス: MIT（全文は [`slack-skills-LICENSE.txt`](slack-skills-LICENSE.txt)）

## 取り込み範囲

- `skills/<name>/SKILL.md` と `references/`（8スキル: block-kit, create-slack-app, slack-api, slack-cli, slack-docs, slack-messaging, slack-search, test-slack-app）
- 上流のプラグインラッパー（`.claude-plugin/`、`.codex-plugin/`、`.cursor-plugin/`、`commands/`、`scripts/`、`docs/`）は取り込まない

## 改変

- 改行は LF に統一
- その他の改変なし

## 更新手順

1. 上流を任意のコミットで clone する
2. `skills/` 配下の8ディレクトリを差し替える（改行を LF に統一）
3. このファイルのコミットハッシュと日付を更新する
