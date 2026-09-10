import { describe, expect, it } from "vitest";
import {
  composerReferenceInsertion,
  composerReferenceValue,
  filterComposerReferences,
  findComposerReferenceToken,
  isKnownComposerReference,
} from "./composer-references";

const skills = [{ name: "review" }, { name: "refactor" }, { name: "web-search" }];
const agents = [{ name: "scout" }, { name: "worker" }];

describe("composer references", () => {
  it("finds slash skill and at agent tokens at a word boundary", () => {
    expect(findComposerReferenceToken("調査 /skill:rev", 13)).toMatchObject({
      kind: "skill",
      query: "rev",
      raw: "/skill:rev",
      start: 3,
      end: 13,
    });
    expect(findComposerReferenceToken("@review", 7)).toMatchObject({ kind: "agent", query: "review" });
    expect(findComposerReferenceToken("email@example.com", 17)).toBeNull();
  });

  it("strips the skill: prefix from slash tokens", () => {
    expect(findComposerReferenceToken("/skill:review", 13)).toMatchObject({
      kind: "skill",
      query: "review",
    });
    expect(findComposerReferenceToken("/skill:REVIEW", 13)?.query).toBe("REVIEW");
  });

  it("handles caret edges and non-reference slashes", () => {
    expect(findComposerReferenceToken("", 0)).toBeNull();
    expect(findComposerReferenceToken("abc", 3)).toBeNull();
    expect(findComposerReferenceToken("/review", 7)).toMatchObject({ query: "review" });
    expect(findComposerReferenceToken("a/b", 3)).toBeNull(); // 単語境界なし
    expect(findComposerReferenceToken("経路/rev", 7)).toMatchObject({ kind: "skill" });
  });

  it("fuzzy filters references with exact and prefix matches first", () => {
    expect(filterComposerReferences(skills, "rev").map((item) => item.name)).toEqual(["review"]);
    expect(filterComposerReferences(skills, "").map((item) => item.name)).toEqual(["review", "refactor", "web-search"]);
  });

  it("matches substrings and character subsequences with stable ordering", () => {
    // 部分文字列（contains）: position スコア
    expect(filterComposerReferences(skills, "search").map((item) => item.name)).toEqual([
      "web-search",
    ]);
    // ばらばらの文字（subsequence）: "wsr" → web-search
    expect(filterComposerReferences(skills, "wsr").map((item) => item.name)).toEqual([
      "web-search",
    ]);
    // 同スコア時は元の順序を保つ
    expect(filterComposerReferences(skills, "re").map((item) => item.name)).toEqual([
      "review",
      "refactor",
    ]);
  });

  it("caps the result list at the limit", () => {
    expect(filterComposerReferences(skills, "", 2)).toHaveLength(2);
    expect(filterComposerReferences(skills, "zzz", 2)).toHaveLength(0);
  });

  it("uses Pi's skill command syntax and an at token for agents", () => {
    expect(composerReferenceValue("skill", "review")).toBe("/skill:review");
    expect(composerReferenceValue("agent", "reviewer")).toBe("@reviewer");
  });

  it("inserts skill names without duplicating the slash", () => {
    expect(
      composerReferenceInsertion({ kind: "skill", raw: "/レ" }, "レビュー担当"),
    ).toBe("/レビュー担当 ");
    expect(
      composerReferenceInsertion({ kind: "skill", raw: "/skill:レ" }, "レビュー担当"),
    ).toBe("/skill:レビュー担当 ");
    expect(
      composerReferenceInsertion({ kind: "agent", raw: "@de" }, "debugger"),
    ).toBe("@debugger ");
  });

  it("recognizes only known reference names", () => {
    const catalog = { skills, agents };
    expect(isKnownComposerReference("skill", "review", catalog)).toBe(true);
    expect(isKnownComposerReference("skill", "unknown", catalog)).toBe(false);
    expect(isKnownComposerReference("agent", "scout", catalog)).toBe(true);
    expect(isKnownComposerReference("agent", "review", catalog)).toBe(false);
    expect(isKnownComposerReference("skill", "scout", catalog)).toBe(false);
  });
});