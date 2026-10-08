import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runGit: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
}));

vi.mock("@/lib/git", () => ({
  runGit: mocks.runGit,
  gitDirectoryError: (directory: string | null | undefined) =>
    !directory || !/^[A-Za-z]:[\\/]|^\\\\|^\/[^/]/.test(directory)
      ? "directory is required"
      : null,
}));

import { GET } from "@backend-runtime/json-business/handlers/diff/files/route";

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

async function getFileCount(directory: string) {
  const req = {
    nextUrl: new URL(
      `http://localhost/api/diff/files?directory=${encodeURIComponent(directory)}&count=1`,
    ),
  };
  const res = await GET(req as never);
  return (await res.json()) as { git?: boolean; count?: number; files?: unknown[]; error?: string };
}

function callsWith(args: string[]) {
  return mocks.runGit.mock.calls.filter((call) => {
    const [, argv] = call as [string, string[]];
    return (argv as string[]).some((arg) => args.includes(arg));
  });
}

async function getWith(directory: string, query: string) {
  const req = { nextUrl: new URL(`http://localhost/api/diff/files?directory=${encodeURIComponent(directory)}&${query}`) };
  const res = await GET(req as never);
  return { status: res.status, body: (await res.json()) as { files?: Array<Record<string, unknown>>; additions?: number; error?: string } };
}

describe("GET /api/diff/files summary and single-file modes", () => {
  beforeEach(() => {
    mocks.runGit.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("lists tracked files from numstat and untracked paths without reading either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-diff-summary-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "new.txt"), "hello\n");
    mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: " M a.ts\n?? new.txt\n", stderr: "" };
      if (args[0] === "diff") return { code: 0, stdout: "4\t1\ta.ts\0", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const { body } = await getWith(dir, "summary=1");
    expect(body.files).toMatchObject([
      { path: "a.ts", additions: 4, deletions: 1, hunks: [], hunksPending: true },
      { path: "new.txt", untracked: true, hunks: [], hunksPending: true },
    ]);
    expect(body.additions).toBe(4);
    const diffCall = callsWith(["diff"])[0] as [string, string[]];
    expect(diffCall[1]).toEqual(expect.arrayContaining(["--numstat", "-z"]));
  });

  it("returns the full hunks of one requested untracked file only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-diff-path-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "new.txt"), "hello\nworld\n");
    writeFileSync(join(dir, "other.txt"), "x\n");
    mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "?? new.txt\n?? other.txt\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const { body } = await getWith(dir, "path=new.txt");
    expect(body.files).toHaveLength(1);
    expect(body.files?.[0]).toMatchObject({ path: "new.txt", additions: 2 });
    expect((body.files?.[0] as { hunks: unknown[] }).hunks).toHaveLength(1);
  });

  it("scopes the tracked diff of one file with a literal pathspec and rejects escapes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-diff-spec-"));
    tempDirs.push(dir);
    mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "R  old.ts -> new.ts\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    await getWith(dir, "path=new.ts&oldPath=old.ts");
    const diffCall = callsWith(["diff"])[0] as [string, string[]];
    expect(diffCall[1].slice(-3)).toEqual(["--", ":(literal)new.ts", ":(literal)old.ts"]);

    const escape = await getWith(dir, "path=..%2Foutside.txt");
    expect(escape.status).toBe(400);
  });
});

describe("GET /api/diff/files", () => {
  beforeEach(() => {
    mocks.runGit.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("skips git diff for a clean worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-diff-files-"));
    tempDirs.push(dir);

    const payload = await getFiles(dir);
    expect(payload).toEqual({ git: true, branch: null, files: [], additions: 0, deletions: 0 });
    // Only rev-parse + status porcelain: no `git diff` subprocesses.
    expect(callsWith(["diff"]).length).toBe(0);
  });

  it("runs git diff only when tracked changes exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-diff-files-"));
    tempDirs.push(dir);
    mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "status") {
        return { code: 0, stdout: " M src/a.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n", stderr: "" };
    });

    const payload = await getFiles(dir);
    expect(payload.git).toBe(true);
    expect(payload.files).toHaveLength(1);
    expect(callsWith(["diff"]).length).toBeGreaterThan(0);
  });

  it("count mode returns only the status line count without diff parsing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-diff-files-"));
    tempDirs.push(dir);
    mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "status") {
        return { code: 0, stdout: " M src/a.ts\n?? new-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const payload = await getFileCount(dir);
    expect(payload.git).toBe(true);
    expect(payload.count).toBe(2);
    expect(payload.files).toEqual([]);
    // count モードでは git diff を一切実行しない。
    expect(callsWith(["diff"]).length).toBe(0);
  });

  it("lists staged and untracked changes before the first commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-diff-initial-"));
    tempDirs.push(dir);
    const { runGit } = await vi.importActual<typeof import("@/lib/git")>("@/lib/git");
    expect((await runGit(dir, ["init"])).code).toBe(0);
    writeFileSync(join(dir, "staged.txt"), "staged\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    expect((await runGit(dir, ["add", "--", "staged.txt"])).code).toBe(0);
    mocks.runGit.mockImplementation(runGit);

    const payload = await getFiles(dir);
    expect(payload.git).toBe(true);
    expect(payload.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "staged.txt", additions: 1 }),
      expect.objectContaining({ path: "new.txt", additions: 1, untracked: true }),
    ]));
    expect(await getFileCount(dir)).toMatchObject({ git: true, count: 2 });
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
