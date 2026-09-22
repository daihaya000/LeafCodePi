import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitDirectoryError: vi.fn(() => null),
  runGit: vi.fn(),
}));

vi.mock("@/lib/git", () => mocks);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/git/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/git/pull", () => {
  beforeEach(() => {
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.runGit.mockReset();
    mocks.runGit.mockResolvedValue({
      code: 0,
      stdout: "Already up to date.\n",
      stderr: "",
    });
  });

  it("pulls the configured upstream", async () => {
    const response = await POST(request({ directory: "C:\\work" }));

    expect(response.status).toBe(200);
    expect(mocks.runGit).toHaveBeenCalledWith("C:\\work", ["pull", "--no-edit"]);
    expect(await response.json()).toEqual({
      ok: true,
      summary: "Already up to date.",
    });
  });

  it("rejects a missing directory before invoking git", async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });
});
