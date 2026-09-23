import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { gitBranchRefs, gitCommitFileDiff, gitDiff, gitLogGraph, runGit } from "./git";

beforeEach(() => mocks.spawn.mockReset());

it("decodes UTF-8 across stdout and stderr chunk boundaries", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  mocks.spawn.mockReturnValue(child);
  const result = runGit(".", ["status"]);
  for (const byte of Buffer.from("変更😀\n", "utf8")) {
    child.stdout.write(Buffer.from([byte]));
    child.stderr.write(Buffer.from([byte]));
  }
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0);
  expect(await result).toEqual({ code: 0, stdout: "変更😀\n", stderr: "変更😀\n" });
});

it.each(["staged", "unstaged"])("rejects a partial diff when %s git diff fails", async (failed) => {
  mocks.spawn.mockImplementation((_command: string, args: string[] = []) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const isStaged = args.includes("--cached");
    const failure = (isStaged ? "staged" : "unstaged") === failed;
    queueMicrotask(() => {
      child.stdout.end("diff output");
      child.stderr.end(failure ? `${failed} failed` : "");
      child.emit("close", failure ? 1 : 0);
    });
    return child;
  });
  await expect(gitDiff(".")).rejects.toThrow(`${failed} failed`);
  const gitCalls = mocks.spawn.mock.calls.filter(([command]) => command === "git");
  expect(gitCalls).toHaveLength(2);
  expect(gitCalls[0][1]).toContain("--cached");
});

it("uses integer pagination arguments for fractional graph requests", async () => {
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  await gitLogGraph(".", 1.5, 2.5);
  const gitCalls = mocks.spawn.mock.calls.filter(([command]) => command === "git");
  expect(gitCalls).toHaveLength(1);
  expect(gitCalls[0][1]).toContain("-n2");
  expect(gitCalls[0][1]).toContain("--skip=2");
});

it("rejects branch refs when for-each-ref fails instead of returning an empty list", async () => {
  mocks.spawn.mockImplementation((_command: string, args: string[] = []) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const failed = args.includes("for-each-ref");
    queueMicrotask(() => {
      child.stdout.end(failed ? "" : "main\n");
      child.stderr.end(failed ? "refs unavailable" : "");
      child.emit("close", failed ? 1 : 0);
    });
    return child;
  });
  await expect(gitBranchRefs(".")).rejects.toThrow("refs unavailable");
  const gitCalls = mocks.spawn.mock.calls.filter(([command]) => command === "git");
  expect(gitCalls).toHaveLength(2);
  expect(gitCalls[1][1]).toContain("for-each-ref");
});

it.each(["src/file[1].txt", "src/version..old.txt"])(
  "uses a literal pathspec for %s",
  async (filePath) => {
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    await gitCommitFileDiff(".", "abcdef0", filePath);
    const gitCalls = mocks.spawn.mock.calls.filter(([command]) => command === "git");
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0][1].slice(-2)).toEqual(["--", `:(literal)${filePath}`]);
  },
);

it("rejects parent directory traversal in a commit file path", async () => {
  await expect(gitCommitFileDiff(".", "abcdef0", "src/../secret.txt"))
    .rejects.toThrow("invalid file path");
  expect(mocks.spawn.mock.calls.filter(([command]) => command === "git")).toHaveLength(0);
});
