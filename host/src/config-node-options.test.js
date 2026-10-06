import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { withQuietExperimentalWarnings } from "./config.js";

test("withQuietExperimentalWarnings appends the flag and keeps existing NODE_OPTIONS", () => {
  assert.equal(withQuietExperimentalWarnings({}).NODE_OPTIONS, "--disable-warning=ExperimentalWarning");
  assert.equal(
    withQuietExperimentalWarnings({ NODE_OPTIONS: "--max-old-space-size=4096" }).NODE_OPTIONS,
    "--max-old-space-size=4096 --disable-warning=ExperimentalWarning",
  );
  const env = { A: "1" };
  assert.equal(withQuietExperimentalWarnings(env).A, "1");
  assert.equal(env.NODE_OPTIONS, undefined, "input env is not mutated");
});

test("withQuietExperimentalWarnings respects an explicit warning choice", () => {
  for (const options of ["--trace-warnings", "--no-warnings", "--disable-warning=ExperimentalWarning"]) {
    const env = { NODE_OPTIONS: options };
    assert.equal(withQuietExperimentalWarnings(env), env);
  }
});

test("the flag silences the node:sqlite ExperimentalWarning in a child", () => {
  const result = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
    env: withQuietExperimentalWarnings({ ...process.env, NODE_OPTIONS: "" }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
});
