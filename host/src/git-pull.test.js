import assert from "node:assert/strict";
import test from "node:test";
import { GIT_PULL_TIMEOUT_MS, pullLatestSources } from "./git-pull.js";

test("pullLatestSources runs a non-interactive fast-forward pull", () => {
  let call;
  const logs = [];
  const errors = [];
  const result = pullLatestSources({
    repoRoot: "C:\\repo",
    env: { PATH: "test" },
    spawnSync: (...args) => {
      call = args;
      return { status: 0, stdout: "Already up to date.\n", stderr: "" };
    },
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  });

  assert.equal(result, true);
  assert.equal(call[0], "git");
  assert.deepEqual(call[1], ["pull", "--ff-only"]);
  assert.equal(call[2].cwd, "C:\\repo");
  assert.equal(call[2].env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(call[2].timeout, GIT_PULL_TIMEOUT_MS);
  assert.ok(logs.some((message) => message.includes("Already up to date.")));
  assert.deepEqual(errors, []);
});

test("pullLatestSources keeps the local sources when pull fails", () => {
  const errors = [];
  const result = pullLatestSources({
    repoRoot: "C:\\repo",
    spawnSync: () => ({ status: 1, stdout: "", stderr: "fatal: offline" }),
    error: (message) => errors.push(message),
  });

  assert.equal(result, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /continuing with local sources/);
  assert.match(errors[0], /git exited 1/);
});
