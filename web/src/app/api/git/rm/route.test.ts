import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "leafcode-rm-"));
  tempDirs.push(root);
  const directory = join(root, "repo");
  mkdirSync(directory);
  return { root, directory };
}

describe("POST /api/git/rm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.commitPathError.mockReturnValue(null);
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.runGit.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
  });

  it("rejects a child of an external directory link without deleting the target", async () => {
    const { root, directory } = workspace();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(directory, "link"), process.platform === "win32" ? "junction" : "dir");

    const response = await POST(request({ directory, path: "link/keep.txt" }));

    expect(response.status).toBe(403);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("does not treat a git failure as an untracked file", async () => {
    const { directory } = workspace();
    writeFileSync(join(directory, "keep.txt"), "keep");
    mocks.runGit.mockResolvedValue({ code: 128, stdout: "", stderr: "index unreadable" });

    const response = await POST(request({ directory, path: "keep.txt" }));

    expect(response.status).toBe(500);
    expect(readFileSync(join(directory, "keep.txt"), "utf8")).toBe("keep");
  });

  it("deletes an untracked file after a successful empty index lookup", async () => {
    const { directory } = workspace();
    writeFileSync(join(directory, "new.txt"), "new");
    mocks.runGit.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const response = await POST(request({ directory, path: "new.txt" }));

    expect(response.status).toBe(200);
    expect(() => readFileSync(join(directory, "new.txt"))).toThrow();
    expect(mocks.runGit).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-string directory before filesystem operations", async () => {
    const response = await POST(
      request({ directory: 123, path: "src/app.ts" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.runGit).not.toHaveBeenCalled();
  });
});
