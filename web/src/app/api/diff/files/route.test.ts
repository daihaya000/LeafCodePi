import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runGit: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
}));

vi.mock("@/lib/git", () => ({ runGit: mocks.runGit }));

import { GET } from "./route";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function getFiles(directory: string) {
  const req = {
    nextUrl: new URL(`http://localhost/api/diff/files?directory=${encodeURIComponent(directory)}`),
  };
  const res = await GET(req as never);
  return (await res.json()) as { git?: boolean; files?: unknown[]; error?: string };
}

describe("GET /api/diff/files", () => {
  beforeEach(() => {
    mocks.runGit.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("reuses a clean result within the TTL instead of re-running git", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-diff-files-"));
    tempDirs.push(dir);

    const first = await getFiles(dir);
    expect(first).toEqual({ git: true, branch: null, files: [], additions: 0, deletions: 0 });
    const callsAfterFirst = mocks.runGit.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Same directory within TTL: served from cache, no new git processes.
    await expect(getFiles(dir)).resolves.toEqual(first);
    expect(mocks.runGit.mock.calls.length).toBe(callsAfterFirst);

    // Different directory misses the cache and runs git again.
    const other = mkdtempSync(join(tmpdir(), "llcode-diff-files-other-"));
    tempDirs.push(other);
    await getFiles(other);
    expect(mocks.runGit.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("returns git:false for a non-repository directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-diff-files-nonrepo-"));
    tempDirs.push(dir);
    mocks.runGit.mockResolvedValue({ code: 128, stdout: "", stderr: "not a git repository" });
    const payload = await getFiles(dir);
    expect(payload.git).toBe(false);
    expect(payload.error).toBe("not a git repository");
  });
});
