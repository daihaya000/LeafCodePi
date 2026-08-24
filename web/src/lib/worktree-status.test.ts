import { describe, expect, it } from "vitest";
import { statusFromChangedFileCount } from "./worktree-status";

describe("statusFromChangedFileCount", () => {
  it("shows a clean status when no files changed", () => {
    expect(statusFromChangedFileCount(0)).toBe("idle");
  });

  it("shows changes when at least one file changed", () => {
    expect(statusFromChangedFileCount(1)).toBe("ready");
  });
});
