import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { gitDirectoryError } from "./git";

describe("gitDirectoryError", () => {
  it("rejects missing and relative paths", () => {
    assert.equal(gitDirectoryError(null), "directory is required");
    assert.equal(gitDirectoryError("relative/path"), "directory is required");
  });

  it("rejects absolute paths outside browse allowlist", () => {
    assert.equal(
      gitDirectoryError("C:\\Windows\\System32"),
      "directory is not allowed",
    );
  });
});
