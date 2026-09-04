import assert from "node:assert/strict";
import test from "node:test";
import { hardKillTree, softKillTree, stopProcessTreeGracefully } from "./process-stop.js";

test("Linux soft kill targets the detached process group", () => {
  const calls = [];
  assert.equal(
    softKillTree(42, {
      platform: "linux",
      kill: (pid, signal) => calls.push([pid, signal]),
    }),
    true,
  );
  assert.deepEqual(calls, [[-42, "SIGTERM"]]);
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
    selfPid: 42,
    kill: (pid, signal) => calls.push([pid, signal]),
  };
  assert.equal(softKillTree(42, deps), false);
  assert.equal(hardKillTree(42, deps), false);
  assert.equal(
    await stopProcessTreeGracefully({
      pid: 42,
      selfPid: 42,
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
    hardKillTree(42, {
      platform: "linux",
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        if (pid < 0) throw new Error("not a process group");
      },
    }),
    true,
  );
  assert.deepEqual(calls, [[-42, "SIGKILL"], [42, "SIGKILL"]]);
});

test("stopProcessTreeGracefully uses Linux signals and escalates", async () => {
  let alive = true;
  const signals = [];
  const result = await stopProcessTreeGracefully({
    pid: 42,
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
  assert.deepEqual(signals, [[-42, "SIGTERM"], [-42, "SIGKILL"]]);
});

test("stopProcessTreeGracefully reports alive when hard kill fails", async () => {
  const result = await stopProcessTreeGracefully({
    pid: 42,
    platform: "linux",
    isAlive: () => true,
    kill: () => {},
    sleep: async () => {},
    softWaitMs: 0,
    pollMs: 0,
  });
  assert.equal(result, "alive");
});
