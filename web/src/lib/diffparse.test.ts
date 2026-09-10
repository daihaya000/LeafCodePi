import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, untrackedHunk } from "./diffparse";

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-old line
+new line
+added line
 context
`;

describe("parseUnifiedDiff", () => {
  it("parses paths, hunks, and add/delete counts", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/a.ts");
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[0].binary).toBe(false);
    const hunk = files[0].hunks[0];
    expect(hunk.header).toBe("@@ -1,3 +1,4 @@");
    expect(hunk.lines).toEqual([
      { t: " ", text: "const a = 1;" },
      { t: "-", text: "old line" },
      { t: "+", text: "new line" },
      { t: "+", text: "added line" },
      { t: " ", text: "context" },
    ]);
  });

  it("does not add a phantom empty context line at the block end", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const hunk = files[0].hunks[0];
    expect(hunk.lines.some((line) => line.t === " " && line.text === "")).toBe(false);
  });

  it("parses multiple files and binary entries", () => {
    const text = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-x
+y
diff --git a/img.png b/img.png
index 333..444 100644
Binary files a/img.png and b/img.png differ
`;
    const files = parseUnifiedDiff(text);
    expect(files.map((file) => file.path)).toEqual(["a.ts", "img.png"]);
    expect(files[1].binary).toBe(true);
    expect(files[1].hunks).toHaveLength(0);
  });

  it("keeps --- and +++ lines inside a hunk as content", () => {
    const text = `diff --git a/x.md b/x.md
index 111..222 100644
--- a/x.md
+++ b/x.md
@@ -1,2 +1,2 @@
-normal
+--- not a header
+++ also not a header
`;
    const files = parseUnifiedDiff(text);
    const lines = files[0].hunks[0].lines;
    expect(lines.find((line) => line.t === "+" && line.text === "--- not a header")).toBeTruthy();
    // "+++" は hunk 内では追加行の "+" が剥がれ "++" が本文になる
    expect(lines.find((line) => line.t === "+" && line.text === "++ also not a header")).toBeTruthy();
  });

  it("handles quoted paths with spaces and renames", () => {
    const text = `diff --git "a/old name.ts" "b/new name.ts"
similarity index 95%
rename from old name.ts
rename to new name.ts
index 111..222 100644
--- "a/old name.ts"
+++ "b/new name.ts"
@@ -1 +1 @@
-x
+y
`;
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("new name.ts");
    expect(files[0].oldPath).toBe("old name.ts");
  });

  it("returns an empty list for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("   \n  ")).toEqual([]);
  });
});

describe("untrackedHunk", () => {
  it("builds an all-added hunk from content", () => {
    const hunk = untrackedHunk("line1\nline2\n");
    expect(hunk.header).toBe("@@ -0,0 +1,2 @@");
    expect(hunk.lines).toEqual([
      { t: "+", text: "line1" },
      { t: "+", text: "line2" },
    ]);
  });

  it("caps the shown lines and notes the remainder", () => {
    const content = Array.from({ length: 405 }, (_, i) => `line${i}`).join("\n");
    const hunk = untrackedHunk(content, 400);
    expect(hunk.lines).toHaveLength(401);
    expect(hunk.lines[400]).toEqual({ t: " ", text: "… (5 more lines)" });
    expect(hunk.header).toBe("@@ -0,0 +1,405 @@");
  });

  it("handles empty content", () => {
    const hunk = untrackedHunk("");
    expect(hunk.header).toBe("@@ -0,0 +1,0 @@");
    expect(hunk.lines).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const hunk = untrackedHunk("a\r\nb\r\n");
    expect(hunk.header).toBe("@@ -0,0 +1,2 @@");
    expect(hunk.lines.map((line) => line.text)).toEqual(["a", "b"]);
  });
});