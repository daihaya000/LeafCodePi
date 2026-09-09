import { describe, expect, it } from "vitest";
import { suggestCommitMessage, type CommitFileInfo } from "./commit-message";

const file = (path: string, untracked = false): CommitFileInfo => ({ path, untracked });

describe("suggestCommitMessage", () => {
  it("returns an empty message when no files are given", () => {
    expect(suggestCommitMessage([])).toBe("");
  });

  it("names a single file with the matching verb", () => {
    expect(suggestCommitMessage([file("src/a.ts")])).toBe("更新 a.ts");
    expect(suggestCommitMessage([file("src/a.ts", true)])).toBe("追加 a.ts");
  });

  it("uses the basename for a single file", () => {
    expect(suggestCommitMessage([file("C:/repo/deep/nested/a.ts")])).toBe(
      "更新 a.ts",
    );
  });

  it("collapses a common directory prefix", () => {
    expect(
      suggestCommitMessage([file("src/lib/a.ts"), file("src/lib/b.ts")]),
    ).toBe("src/lib の2ファイルを更新");
  });

  it("uses the common segment prefix only when it is a real directory", () => {
    expect(
      suggestCommitMessage([file("src/lib/a/b.ts"), file("src/lib/a/x/y.ts")]),
    ).toBe("src/lib/a の2ファイルを更新");
  });

  it("falls back to a plain count without a shared directory", () => {
    expect(
      suggestCommitMessage([file("src/a.ts"), file("test/a.test.ts")]),
    ).toBe("2ファイルを更新");
  });

  it("uses Add when every file is untracked", () => {
    expect(
      suggestCommitMessage([file("new/a.ts", true), file("new/b.ts", true)]),
    ).toBe("new の2ファイルを追加");
  });

  it("normalizes Windows separators", () => {
    expect(
      suggestCommitMessage([file("C:\\repo\\src\\a.ts"), file("C:\\repo\\src\\b.ts")]),
    ).toBe("C:/repo/src の2ファイルを更新");
    expect(suggestCommitMessage([file("C:\\repo\\a.ts")])).toBe("更新 a.ts");
  });

  it("handles a mix of tracked and untracked files as Update", () => {
    expect(
      suggestCommitMessage([file("src/a.ts"), file("src/b.ts", true)]),
    ).toBe("src の2ファイルを更新");
  });
});