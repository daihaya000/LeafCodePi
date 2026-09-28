import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("input focus policy", () => {
  it("keeps focus frames neutral globally", async () => {
    const css = await readFile(new URL("./globals.css", import.meta.url), "utf8");

    expect(css).toContain(":where(input, textarea, select):focus");
    expect(css).toContain("border-color: var(--border-strong) !important;");
    expect(css).toContain("outline: none !important;");
    expect(css).toContain("box-shadow: none !important;");
    expect(css).toContain(":where([class~=\"focus-within:border-accent\"]):focus-within");
  });
});

describe("timeline scroll stability", () => {
  it("does not defer timeline rows with content-visibility", async () => {
    const css = await readFile(new URL("./globals.css", import.meta.url), "utf8");
    const rule = css.match(/\.task-message-row\s*\{[^}]*\}/)?.[0] ?? "";

    // 遅延描画は履歴を遡った最初のスクロールでレイアウトが集中し、
    // スマホで指に追従しないジャンクになる。行は常に描画する。
    expect(rule).toContain("min-width: 0");
    expect(rule).not.toContain("content-visibility");
    expect(rule).not.toContain("contain-intrinsic-size");
  });
});
