import assert from "node:assert/strict";
import { test } from "node:test";
import { createResumePrompt } from "./restart-resume-prompt.mjs";

test("the resume prompt delegates to the attached runtime with the resume flag", async () => {
  const calls = [];
  const runtime = {
    promptTask: async (...args) => {
      calls.push(args);
      return { id: "task-1", status: "working" };
    },
  };
  const resume = createResumePrompt({ getRuntime: () => runtime });
  await resume("task-1", "続きを実行してください");
  assert.deepEqual(calls, [["task-1", "続きを実行してください", undefined, { resume: true }]]);
});

test("a missing runtime refuses instead of reporting a resume", async () => {
  const detached = createResumePrompt({ getRuntime: () => null });
  await assert.rejects(() => detached("task-1", "続き"), /runtime unavailable/);
  // A runtime that attached without a prompt path is refused the same way.
  const broken = createResumePrompt({ getRuntime: () => ({}) });
  await assert.rejects(() => broken("task-1", "続き"), /runtime unavailable/);
});

test("the runtime is resolved per call, so a late attach is used", async () => {
  let runtime = null;
  const resume = createResumePrompt({ getRuntime: () => runtime });
  await assert.rejects(() => resume("task-1", "続き"), /runtime unavailable/);
  const calls = [];
  runtime = { promptTask: async (id) => calls.push(id) };
  await resume("task-1", "続き");
  assert.deepEqual(calls, ["task-1"]);
});

test("a caller must supply the runtime lookup", () => {
  assert.throws(() => createResumePrompt({}), /getRuntime is required/);
});
