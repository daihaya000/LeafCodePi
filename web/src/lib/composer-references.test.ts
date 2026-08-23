import { describe, expect, it } from "vitest";
import {
  composerReferenceValue,
  filterComposerReferences,
  findComposerReferenceToken,
} from "./composer-references";

const skills = [{ name: "review" }, { name: "refactor" }, { name: "web-search" }];

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

  it("fuzzy filters references with exact and prefix matches first", () => {
    expect(filterComposerReferences(skills, "rev").map((item) => item.name)).toEqual(["review"]);
    expect(filterComposerReferences(skills, "").map((item) => item.name)).toEqual(["review", "refactor", "web-search"]);
  });

  it("uses Pi's skill command syntax and an at token for agents", () => {
    expect(composerReferenceValue("skill", "review")).toBe("/skill:review");
    expect(composerReferenceValue("agent", "reviewer")).toBe("@reviewer");
  });
});
