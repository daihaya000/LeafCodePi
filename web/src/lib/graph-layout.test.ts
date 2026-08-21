import { describe, expect, it } from "vitest";
import { layoutGraph, pickBranchBadges } from "./graph-layout";
import type { GraphCommit } from "./types";

function c(
  hash: string,
  parents: string[],
  subject = hash,
): GraphCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    subject,
    author: "t",
    authorEmail: "t@opencode.local",
    date: "2026-01-01",
  };
}

describe("layoutGraph", () => {
  it("keeps first-parent chain on lane 0", () => {
    const rows = layoutGraph([
      c("c3", ["c2"]),
      c("c2", ["c1"]),
      c("c1", []),
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
  });

  it("forks a second lane for merge and converges later", () => {
    // newest → oldest (matches real opencode history shape)
    const rows = layoutGraph([
      c("tip", ["merge"]),
      c("merge", ["main", "side"], "merge"),
      c("side", ["base"]),
      c("main", ["base"]),
      c("base", []),
    ]);
    expect(rows[1].commit.hash).toBe("merge");
    expect(rows[1].edges.some((e) => e.half === "lower")).toBe(true);
    expect(rows[2].lane).toBe(1); // side branch
    // base is reached from both lanes → upper merge into lane 0
    const base = rows.find((r) => r.commit.hash === "base");
    expect(base?.lane).toBe(0);
    expect(base?.edges.some((e) => e.half === "upper")).toBe(true);
  });
});

describe("pickBranchBadges", () => {
  it("prefers current and caps extras", () => {
    const { shown, more } = pickBranchBadges(
      ["webui/a", "master", "webui/b"],
      "webui/a",
      2,
    );
    expect(shown[0]).toBe("webui/a");
    expect(shown).toContain("master");
    expect(more).toBe(1);
  });
});
