import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commitPathError: vi.fn(() => null),
  gitDirectoryError: vi.fn(() => null),
  runGit: vi.fn(),
}));

vi.mock("@/lib/git", () => mocks);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/git/rm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/git/rm", () => {
  beforeEach(() => {
    mocks.commitPathError.mockReturnValue(null);
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.runGit.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
  });

  it("rejects a non-string directory before filesystem operations", async () => {
    const response = await POST(
      request({ directory: 123, path: "src/app.ts" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });
});
