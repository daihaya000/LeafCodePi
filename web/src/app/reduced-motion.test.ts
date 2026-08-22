import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

// globals.css を本番と同じ postcss 設定でコンパイルする
async function compileGlobalsCss(): Promise<string> {
  const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
  const result = await postcss([tailwindcss()]).process(css, { from: undefined });
  return result.css;
}

// 回帰: OS の「アニメーション効果」無効（prefers-reduced-motion）でも
// ローディングスピナーだけは回し続けること（稼働状態を示す必須インジケータのため）
test("prefers-reduced-motion 下でも .animate-spin は回転し続ける", async () => {
  const css = await compileGlobalsCss();

  // スピナーユーティリティと回転 keyframes が出力されている
  expect(css).toContain(".animate-spin");
  expect(css).toMatch(/@keyframes spin\s*\{/);

  // reduce ブロック: 全要素のアニメ停止ルールの後に .animate-spin 免除が続く
  const compact = css.replace(/\s+/g, "");
  const media = compact.indexOf("prefers-reduced-motion:reduce");
  expect(media).toBeGreaterThanOrEqual(0);

  const kill = compact.indexOf("animation-iteration-count:1!important", media);
  // 末尾セミコロン有無の差（minify 設定）に影響されないよう `}` は含めない
  const exemption = compact.indexOf(
    ".animate-spin{animation-duration:1s!important;animation-iteration-count:infinite!important",
    media,
  );
  expect(kill).toBeGreaterThan(media);
  expect(exemption).toBeGreaterThan(kill);
});
