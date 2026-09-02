import assert from "node:assert/strict";
import test from "node:test";
import { getListeningPids, getPortListenerStatus, runPortSnapshot } from "./port-scanner.js";

test("Linux listener scan prefers ss", () => {
  const calls = [];
  const snapshot = runPortSnapshot({
    platform: "linux",
    execFileSync: (command) => {
      calls.push(command);
      return 'LISTEN 0 128 127.0.0.1:3010 0.0.0.0:* users:(("node",pid=321,fd=1))';
    },
  }, 3010);
  assert.deepEqual(calls, ["ss"]);
  assert.deepEqual(getListeningPids(3010, snapshot, { platform: "linux" }), [321]);
});

test("Linux listener scan falls back to lsof", () => {
  const calls = [];
  const snapshot = runPortSnapshot({
    platform: "linux",
    execFileSync: (command) => {
      calls.push(command);
      if (command === "ss") throw new Error("ss missing");
      return "654\n";
    },
  }, 8081);
  assert.deepEqual(calls, ["ss", "lsof"]);
  assert.equal(snapshot.format, "lsof");
  assert.deepEqual(getListeningPids(8081, snapshot, { platform: "linux" }), [654]);
});

test("lsof with no matches is an available empty snapshot", () => {
  const snapshot = runPortSnapshot({
    platform: "linux",
    execFileSync: (command) => {
      if (command === "ss") throw new Error("ss missing");
      throw Object.assign(new Error("no matches"), { status: 1, stdout: "", stderr: "" });
    },
  }, 8081);
  assert.deepEqual(snapshot, { output: "", format: "lsof" });
  assert.deepEqual(getPortListenerStatus(8081, snapshot, { platform: "linux" }), {
    available: true,
    listening: false,
    pids: [],
  });
});

test("ss reports a listener even when process metadata is hidden", () => {
  const snapshot = {
    output: "LISTEN 0 128 127.0.0.1:8081 0.0.0.0:*",
    format: "ss",
  };
  assert.deepEqual(getPortListenerStatus(8081, snapshot, { platform: "linux" }), {
    available: true,
    listening: true,
    pids: [],
  });
});
