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
  return new NextRequest("http://localhost/api/git/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/git/commit", () => {
  beforeEach(() => {
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.commitPathError.mockReturnValue(null);
    mocks.runGit.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("rejects a non-string agent before invoking git", async () => {
    const response = await POST(
      request({ directory: "C:\\work", message: "commit", paths: ["src/app.ts"], agent: 123 }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("rejects a non-array paths value before invoking git", async () => {
    const response = await POST(
      request({ directory: "C:\\work", message: "commit", paths: "src/app.ts" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("rejects a non-string commit message before invoking git", async () => {
    const response = await POST(
      request({ directory: "C:\\work", message: 123, paths: ["src/app.ts"] }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("rejects a non-string directory before invoking git", async () => {
    const response = await POST(
      request({ directory: 123, message: "commit", paths: ["src/app.ts"] }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });
});
