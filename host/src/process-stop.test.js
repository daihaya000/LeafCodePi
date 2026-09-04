import assert from "node:assert/strict";
import test from "node:test";
import { hardKillTree, softKillTree, stopProcessTreeGracefully } from "./process-stop.js";

const EXTERNAL_PID = process.pid + 1;

test("Linux soft kill targets the detached process group", () => {
  const calls = [];
  assert.equal(
    softKillTree(EXTERNAL_PID, {
      platform: "linux",
      kill: (pid, signal) => calls.push([pid, signal]),
    }),
    true,
  );
  assert.deepEqual(calls, [[-EXTERNAL_PID, "SIGTERM"]]);
});

test("Linux refuses PID 1 instead of broadcasting kill(-1)", () => {
  const calls = [];
  assert.equal(
    hardKillTree(1, {
      platform: "linux",
      kill: (pid, signal) => calls.push([pid, signal]),
    }),
    false,
  );
  assert.deepEqual(calls, []);
});

test("process controls refuse the host PID", async () => {
  const calls = [];
  const deps = {
    platform: "linux",
    kill: (pid, signal) => calls.push([pid, signal]),
  };
  assert.equal(softKillTree(process.pid, deps), false);
  assert.equal(hardKillTree(process.pid, deps), false);
  assert.equal(
    await stopProcessTreeGracefully({
      pid: process.pid,
      isAlive: () => {
        throw new Error("must not inspect the host PID");
      },
      softKill: () => {
        throw new Error("must not soft-kill the host PID");
      },
      hardKill: () => {
        throw new Error("must not hard-kill the host PID");
      },
    }),
    "gone",
  );
  assert.deepEqual(calls, []);
});

test("Linux kill falls back to the process when it is not a group leader", () => {
  const calls = [];
  assert.equal(
    hardKillTree(EXTERNAL_PID, {
      platform: "linux",
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        if (pid < 0) throw new Error("not a process group");
      },
    }),
    true,
  );
  assert.deepEqual(calls, [[-EXTERNAL_PID, "SIGKILL"], [EXTERNAL_PID, "SIGKILL"]]);
});

test("stopProcessTreeGracefully uses Linux signals and escalates", async () => {
  let alive = true;
  const signals = [];
  const result = await stopProcessTreeGracefully({
    pid: EXTERNAL_PID,
    platform: "linux",
    isAlive: () => alive,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") alive = false;
    },
    sleep: async () => {},
    softWaitMs: 0,
    pollMs: 0,
  });
  assert.equal(result, "hard");
  assert.deepEqual(signals, [[-EXTERNAL_PID, "SIGTERM"], [-EXTERNAL_PID, "SIGKILL"]]);
});

test("stopProcessTreeGracefully reports alive when hard kill fails", async () => {
  const result = await stopProcessTreeGracefully({
    pid: EXTERNAL_PID,
    platform: "linux",
    isAlive: () => true,
    kill: () => {},
    sleep: async () => {},
    softWaitMs: 0,
    pollMs: 0,
  });
  assert.equal(result, "alive");
});
