# MEMORY

最終更新: 2026-09-05

## 直近の作業

### 本番ビルド型エラー修正（2026-09-05）

`npm run build` が TypeScript チェックで失敗していた。原因と修正:

1. **GlobalAttentionProvider.test.tsx** — `kinds: [...] as const` が `readonly` タプルになり、可変配列の `AttentionItemDto["kinds"]` に代入不可。`AttentionItemDto` 明示注釈に変更。
2. **hang-watchdog.test.ts** — `let resumed: T | null = null` が CFA で `null` に狭まり、コールバック代入後も `never` 扱い。`let resumed = null as ResumeCapture | null` に変更。
3. **harness.ts `readOfflineSessionSnapshot`** — `state().pi` が `PiModule | null` なのに未チェックで参照。`openSettingsManager` と同様の null ガードを追加。

検証: `npm run build` 成功、関連 vitest 27 件パス。

## ビルドメモ

- 本番ビルドは `scripts/build-web.mjs` → OneDrive 外ミラーで `next build`
- `tsconfig.json` は `**/*.ts(x)` を含むためテストも本番型チェック対象
