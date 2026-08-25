import { describe, expect, it } from "vitest";
import { tintCodeLine } from "@/lib/difftint";

describe("tintCodeLine", () => {
  it("escapes HTML in non-code files", () => {
    expect(tintCodeLine("<script>&\"'</script>", "readme.md")).toBe(
      "&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;",
    );
  });

  it("tints keywords and strings in code files", () => {
    const out = tintCodeLine('const x = "hi";', "a.ts");
    expect(out).toContain('<span class="text-accent">const</span>');
    expect(out).toContain('<span class="text-success">&quot;hi&quot;</span>');
  });

  it("does not mistake entity # for a comment marker", () => {
    // Negative lookbehind must keep `&#39;` (escaped quote) out of comment tint.
    const out = tintCodeLine("const s = 'hi'; // note", "a.ts");
    expect(out).toContain("<span class=\"text-faint\">// note</span>");
    // The escaped quote inside the string pass stays intact.
    expect(out).not.toContain("&lt;span");
  });

  it("keeps emitted markup itself intact (no double-wrapping of span tags)", () => {
    const out = tintCodeLine('call("a<b");', "a.ts");
    // String contents are escaped before span insertion, so no stray angle
    // brackets can leak into the emitted markup.
    expect(out).toContain("&lt;b&quot;");
    expect(out).not.toContain("<span class=\"text-accent\"><span");
  });

  it("handles empty and whitespace input", () => {
    expect(tintCodeLine("", "a.ts")).toBe("");
    expect(tintCodeLine("   ", "a.ts")).toBe("   ");
  });
});