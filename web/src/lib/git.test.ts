import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { GIT_MAX_CONCURRENT_OUTPUT_CAPTURES, GIT_MAX_OUTPUT_CHARS, gitBranchRefs, gitCommitFileDiff, gitCommitFiles, gitDiff, gitLogGraph, runGit, withGitRequestSignal } from "./git";

beforeEach(() => mocks.spawn.mockReset());

it("cancels read-only Git capture and releases its slot, without affecting an unscoped write", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  mocks.spawn.mockReturnValue(child);
  const controller = new AbortController();
  const result = withGitRequestSignal(controller.signal, () => runGit(".", ["status"]));
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(child.kill).toHaveBeenCalledWith("SIGKILL"); child.emit("close", 0);
  const write = runGit(".", ["commit"]); child.emit("close", 0);
  expect((await write).code).toBe(0);
  await expect(withGitRequestSignal(controller.signal, () => runGit(".", ["status"]))).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
});

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

it("kills git and rejects when output exceeds the buffer ceiling", async () => {
  const kill = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill,
    pid: 123,
  });
  mocks.spawn.mockReturnValue(child);
  const result = runGit(".", ["diff"], 30_000, undefined, 10);
  child.stdout.write("0123456789ab");
  await expect(result).rejects.toThrow("git output exceeded 10 characters");
  if (process.platform !== "win32") expect(kill).toHaveBeenCalledWith("SIGKILL");
});

it("rejects excess concurrent git output captures before spawning them", async () => {
  const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; pid: number }> = [];
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      pid: 123,
    });
    children.push(child);
    return child;
  });
  const running = Array.from({ length: GIT_MAX_CONCURRENT_OUTPUT_CAPTURES }, () => runGit(".", ["diff"]));
  expect(mocks.spawn).toHaveBeenCalledTimes(GIT_MAX_CONCURRENT_OUTPUT_CAPTURES);
  await expect(runGit(".", ["diff"])).rejects.toThrow(`git output capacity reached (max ${GIT_MAX_CONCURRENT_OUTPUT_CAPTURES} concurrent captures)`);
  expect(mocks.spawn).toHaveBeenCalledTimes(GIT_MAX_CONCURRENT_OUTPUT_CAPTURES);

  const payload = "漢".repeat(GIT_MAX_OUTPUT_CHARS);
  for (const child of children) {
    child.stdout.end(payload);
    child.stderr.end();
    child.emit("close", 0);
  }
  const results = await Promise.all(running);
  expect(results).toHaveLength(GIT_MAX_CONCURRENT_OUTPUT_CAPTURES);
  expect(results.reduce((total, result) => total + result.stdout.length + result.stderr.length, 0))
    .toBe(GIT_MAX_CONCURRENT_OUTPUT_CAPTURES * GIT_MAX_OUTPUT_CHARS);
});

it("enforces the hard output ceiling despite a larger caller override", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    pid: 123,
  });
  mocks.spawn.mockReturnValue(child);
  const result = runGit(".", ["diff"], 30_000, undefined, GIT_MAX_OUTPUT_CHARS * 2);
  child.stdout.write("x".repeat(GIT_MAX_OUTPUT_CHARS + 1));
  await expect(result).rejects.toThrow(`git output exceeded ${GIT_MAX_OUTPUT_CHARS} characters`);
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

it("reports the second failure when the first failed diff has no stderr", async () => {
  mocks.spawn.mockImplementation((_command: string, args: string[] = []) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      child.stderr.end(args.includes("--cached") ? "" : "unstaged failure details");
      child.emit("close", 1);
    });
    return child;
  });
  await expect(gitDiff(".")).rejects.toThrow("unstaged failure details");
  expect(mocks.spawn.mock.calls.filter(([command]) => command === "git")).toHaveLength(2);
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

it("parses NUL-delimited commit filenames without quoting or newline loss", async () => {
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      child.stdout.end("M\0src/name\twith-tab.txt\0A\0src/name\nwith-newline.txt\0");
      child.emit("close", 0);
    });
    return child;
  });
  expect(await gitCommitFiles(".", "abcdef0")).toEqual([
    { status: "M", path: "src/name\twith-tab.txt" },
    { status: "A", path: "src/name\nwith-newline.txt" },
  ]);
  const gitCalls = mocks.spawn.mock.calls.filter(([command]) => command === "git");
  expect(gitCalls).toHaveLength(1);
  expect(gitCalls[0][1]).toContain("-z");
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

it.each(["", ".", "src/.", "src/", "src/../secret.txt"])(
  "rejects an unsafe commit file path %j before invoking git",
  async (filePath) => {
    await expect(gitCommitFileDiff(".", "abcdef0", filePath))
      .rejects.toThrow("invalid file path");
    expect(mocks.spawn.mock.calls.filter(([command]) => command === "git")).toHaveLength(0);
  },
);

it("counts stdout and stderr together against one ceiling", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    pid: 123,
  });
  mocks.spawn.mockReturnValue(child);
  const result = runGit(".", ["diff"], 30_000, undefined, 10);
  child.stdout.write("01234");
  child.stderr.write("56789");
  // The two streams share the limit, so a chunk that only fits alone must fail.
  child.stderr.write("a");
  await expect(result).rejects.toThrow("git output exceeded 10 characters");
});
