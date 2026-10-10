import { BackendTestRequest as Request } from "@/test-request";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitDirectoryError: vi.fn(() => null),
  runGit: vi.fn(),
}));

vi.mock("@/lib/git", () => mocks);

import { POST } from "@backend-runtime/json-business/handlers/git/init/route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/git/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/git/init", () => {
  beforeEach(() => {
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.runGit.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("rejects a non-string directory before invoking git", async () => {
    const response = await POST(request({ directory: 123 }));

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });
});
