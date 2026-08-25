import { describe, expect, it } from "vitest";
import { sameGraphPayload } from "./GraphPanel";
import type { GraphLogPayload } from "@/lib/types";

function payload(overrides?: Partial<GraphLogPayload>): GraphLogPayload {
  return {
    commits: [
      {
        hash: "abc123",
        shortHash: "abc123",
        parents: ["parent1"],
        subject: "fix: 修正",
        author: "user",
        authorEmail: "user@example.com",
        date: "2026-08-25T00:00:00Z",
      },
    ],
    refs: [{ name: "main", hash: "abc123", current: true }],
    currentBranch: "main",
    hasMore: false,
    ...overrides,
  };
}

describe("sameGraphPayload", () => {
  it("returns false for null previous payload", () => {
    expect(sameGraphPayload(null, payload())).toBe(false);
  });

  it("detects identical payloads across polls", () => {
    expect(sameGraphPayload(payload(), payload())).toBe(true);
  });

  it("detects a new commit at the head", () => {
    const prev = payload();
    const next = payload({
      commits: [
        {
          hash: "def456",
          shortHash: "def456",
          parents: ["abc123"],
          subject: "feat: 追加",
          author: "user",
          authorEmail: "user@example.com",
          date: "2026-08-25T01:00:00Z",
        },
        ...prev.commits,
      ],
    });
    expect(sameGraphPayload(prev, next)).toBe(false);
  });

  it("detects a branch change", () => {
    expect(
      sameGraphPayload(payload(), payload({ currentBranch: "feature" })),
    ).toBe(false);
  });
});
