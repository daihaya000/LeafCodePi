import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    vi.clearAllMocks();
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.commitPathError.mockReturnValue(null);
    mocks.runGit.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("commits a staged rename without including unrelated staged or new files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-selected-commit-"));
    const { runGit } = await vi.importActual<typeof import("@/lib/git")>("@/lib/git");
    const run: typeof runGit = (cwd, args, timeout, env) => runGit(cwd, [
      "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${join(dir, "no-hooks")}`, ...args,
    ], timeout, env);
    try {
      expect((await run(dir, ["init"])).code).toBe(0);
      writeFileSync(join(dir, "old.txt"), "same\n");
      writeFileSync(join(dir, "other.txt"), "before\n");
      expect((await run(dir, ["add", "."])).code).toBe(0);
      expect((await run(dir, ["commit", "-m", "initial"])).code).toBe(0);
      expect((await run(dir, ["mv", "old.txt", "new.txt"])).code).toBe(0);
      writeFileSync(join(dir, "other.txt"), "after\n");
      expect((await run(dir, ["add", "other.txt"])).code).toBe(0);
      writeFileSync(join(dir, "late.txt"), "not selected\n");
      mocks.runGit.mockImplementation(run);

      const response = await POST(request({ directory: dir, message: "rename", paths: ["old.txt", "new.txt"] }));
      expect(await response.json()).toMatchObject({ ok: true });
      expect((await run(dir, ["ls-tree", "--name-only", "HEAD"])).stdout).toBe("new.txt\nother.txt\n");
      expect((await run(dir, ["show", "HEAD:other.txt"])).stdout).toBe("before\n");
      expect((await run(dir, ["status", "--porcelain"])).stdout).toContain("?? late.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("rejects a non-boolean all flag before invoking git", async () => {
    const response = await POST(
      request({ directory: "C:\\work", message: "commit", paths: ["src/app.ts"], all: "false" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });
});
