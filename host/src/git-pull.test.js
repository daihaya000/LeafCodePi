import assert from "node:assert/strict";
import test from "node:test";
import { GIT_PULL_TIMEOUT_MS, pullLatestSources } from "./git-pull.js";

test("pullLatestSources skips rebuild when HEAD is unchanged", () => {
  const calls = [];
  const logs = [];
  const errors = [];
  const result = pullLatestSources({
    repoRoot: "C:\\repo",
    env: { PATH: "test" },
    spawnSync: (...args) => {
      calls.push(args);
      return args[1][0] === "pull"
        ? { status: 0, stdout: "Already up to date.\n", stderr: "" }
        : { status: 0, stdout: "abc123\n", stderr: "" };
    },
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  });

  assert.deepEqual(result, { ok: true, updated: false });
  assert.deepEqual(calls.map((call) => call[1]), [["rev-parse", "HEAD"], ["pull", "--ff-only"], ["rev-parse", "HEAD"]]);
  assert.equal(calls[1][0], "git");
  assert.equal(calls[1][2].cwd, "C:\\repo");
  assert.equal(calls[1][2].env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(calls[1][2].timeout, GIT_PULL_TIMEOUT_MS);
  assert.ok(logs.some((message) => message.includes("Already up to date.")));
  assert.deepEqual(errors, []);
});

test("pullLatestSources detects a fast-forward update", () => {
  let revisionChecks = 0;
  const result = pullLatestSources({
    repoRoot: "C:\\repo",
    spawnSync: (_, args) => args[0] === "pull"
      ? { status: 0, stdout: "Updating abc..def", stderr: "" }
      : { status: 0, stdout: ++revisionChecks === 1 ? "abc\n" : "def\n" },
  });
  assert.deepEqual(result, { ok: true, updated: true });
});

test("pullLatestSources rebuilds conservatively when HEAD cannot be checked", () => {
  const result = pullLatestSources({
    repoRoot: "C:\\repo",
    spawnSync: (_, args) => args[0] === "pull"
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 1, stdout: "", stderr: "fatal: unknown revision" },
  });
  assert.deepEqual(result, { ok: true, updated: true });
});

test("pullLatestSources keeps the local sources when pull fails", () => {
  const errors = [];
  const result = pullLatestSources({
    repoRoot: "C:\\repo",
    spawnSync: () => ({ status: 1, stdout: "", stderr: "fatal: offline" }),
    error: (message) => errors.push(message),
  });

  assert.deepEqual(result, { ok: false, updated: false });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /continuing with local sources/);
  assert.match(errors[0], /git exited 1/);
});
