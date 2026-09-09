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

test("keeps all visual effects independent of the OS reduced-motion preference", async () => {
  const css = await compileGlobalsCss();
  expect(css).not.toContain("prefers-reduced-motion");
  expect(css).not.toContain("0.001ms");
  expect(css).toContain(".animate-spin");
  expect(css).toMatch(/@keyframes spin\s*\{/);
  const root = postcss.parse(css);
  for (const [selector, animation] of [
    [".bot-avatar-working", "bot-sway"],
    [".bot-avatar-eyes", "bot-blink"],
    [".status-pulse", "pulse-dot"],
  ]) {
    let found = false;
    root.walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      rule.walkDecls("animation", (declaration) => {
        if (declaration.value.includes(animation) && declaration.value.includes("infinite")) found = true;
      });
    });
    expect(found, selector).toBe(true);
  }
});
