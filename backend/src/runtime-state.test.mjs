import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeControlState } from "./runtime-state.mjs";

test("ordinary polling does not scan auto-update tasks, leases, or background providers", () => {
  let scans = 0;
  const runtime = {
    activeGoalLoopTaskIds: () => ["loop"],
    readAutoUpdateState: () => { scans++; throw new Error("provider unavailable"); },
  };
  for (let i = 0; i < 100; i++) assert.deepEqual(readRuntimeControlState(runtime), { taskIds: ["loop"] });
  assert.equal(scans, 0);
});
test("auto-update opts into one strict scan without duplicating the Goal Loop scan", () => {
  let scans = 0;
  const runtime = {
    activeGoalLoopTaskIds: () => assert.fail("strict scan already includes loops"),
    readAutoUpdateState: () => { scans++; return { supported: true, busy: false }; },
  };
  assert.deepEqual(readRuntimeControlState(runtime, { autoUpdate: true }), { autoUpdate: { supported: true, busy: false } });
  assert.equal(scans, 1);
});
test("missing/failed strict capability is unknown, never idle; detached owners still refuse", () => {
  assert.deepEqual(readRuntimeControlState({}, { autoUpdate: true }), { autoUpdate: null });
  assert.deepEqual(readRuntimeControlState({ readAutoUpdateState: () => { throw new Error("unavailable"); } }, { autoUpdate: true }), { autoUpdate: null });
  assert.throws(() => readRuntimeControlState(null), /unavailable/);
});
