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
