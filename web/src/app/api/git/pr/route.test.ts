import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/git", () => ({
  assertSafeBranchName: vi.fn(),
  gitDirectoryError: vi.fn(() => null),
  runGit: vi.fn(),
}));

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/git/pr", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/git/pr", () => {
  it("rejects a non-string title before invoking GitHub CLI", async () => {
    const response = await POST(
      request({ directory: "C:\\work", title: 123, push: false }),
    );

    expect(response.status).toBe(400);
  });
});
