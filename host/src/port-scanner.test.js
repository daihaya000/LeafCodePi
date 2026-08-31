import assert from "node:assert/strict";
import test from "node:test";
import { getListeningPids, runPortSnapshot } from "./port-scanner.js";

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
