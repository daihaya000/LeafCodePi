---
name: playwright-cli-wrap
description: Windows OpenCode で playwright-cli がハングしないよう、LeafCode host 経由の回避ラッパーを使う。ブラウザ操作、playwright-cli、Playwright CLI、open/goto/snapshot のときに使う。
---

# playwright-cli wrap (Windows / OpenCode)

OpenCode の bash は Job Object 内で子孫プロセスの終了を待つ。`playwright-cli open` は常駐デーモンを残すのでツールが終わらない。

このリポジトリのラッパーは **LeafCode host** に CLI 実行を中継する。デーモンは host の子になり、bash 側には子孫が残らない。

## 呼び出し

LeafCode リポジトリが cwd のとき:

```
node scripts/playwright-cli-wrap/cli.mjs open https://example.com
node scripts/playwright-cli-wrap/cli.mjs goto https://example.com
node scripts/playwright-cli-wrap/cli.mjs snapshot
node scripts/playwright-cli-wrap/cli.mjs close
```

LeafCode host 再起動後は PATH 先頭がこの shim なので、公式スキルどおり `playwright-cli open` でもよい。

## 禁止

- `npx playwright-cli`
- `npx @playwright/cli`
- `npx playwright cli`
- host が止まっている状態で Windows の OpenCode bash から npm の `playwright-cli` を直接叩くこと

host が無いときはラッパーがエラーを返して終了する（ハングさせない）。

## 公式スキル

コマンド一覧・snapshot の読み方は `@playwright/cli` 付属の `playwright-cli` スキルに従う。違うのは起動コマンドだけ。
