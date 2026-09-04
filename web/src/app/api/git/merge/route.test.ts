import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSafeBranchName: vi.fn(),
  gitDirectoryError: vi.fn(() => null),
  runGit: vi.fn(),
}));

vi.mock("@/lib/git", () => mocks);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/git/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/git/merge", () => {
  beforeEach(() => {
    mocks.assertSafeBranchName.mockReset();
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.runGit.mockResolvedValue({ code: 0, stdout: "main", stderr: "" });
  });

  it("rejects an unknown merge direction before invoking git", async () => {
    const response = await POST(
      request({ directory: "C:\\work", branch: "feature", into: "unexpected" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("rejects a non-string branch before invoking git", async () => {
    const response = await POST(
      request({ directory: "C:\\work", branch: 123 }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });
});
