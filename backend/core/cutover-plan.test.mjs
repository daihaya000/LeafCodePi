import assert from "node:assert/strict";
import { test } from "node:test";
import { cutoverPreflight } from "./cutover-plan.mjs";

const ready = (generation = "gen-a") => ({ ok: true, ready: true, runtimeGeneration: generation });

test("a ready Backend of the pinned generation with no work in flight may take over", () => {
  const result = cutoverPreflight({
    backendConfigured: true,
    health: ready(),
    expectedGeneration: "gen-a",
    relayEnabled: true,
    webOwnsRuntime: false,
  });
  assert.deepEqual(result, { ok: true, blockers: [], activeTasks: 0, goalLoopSessions: 0, foreignLeases: 0 });
});

test("an unreachable or unconfigured Backend blocks the cutover", () => {
  assert.deepEqual(cutoverPreflight({}).blockers, [
    { code: "backend-not-configured" },
    { code: "backend-unreachable" },
  ]);
  assert.deepEqual(cutoverPreflight({ backendConfigured: true, health: { ok: false } }).blockers, [
    { code: "backend-unreachable" },
  ]);
});

test("a Backend that is not ready, or has no runtime, blocks the cutover", () => {
  assert.deepEqual(
    cutoverPreflight({ backendConfigured: true, health: { ok: true, ready: false } }).blockers,
    [{ code: "backend-not-ready" }],
  );
  // Attached but not ready: readiness is the startup sequence, not the socket.
  assert.deepEqual(
    cutoverPreflight({ backendConfigured: true, health: { ok: true, ready: false, runtimeGeneration: "gen-a" } }).blockers,
    [{ code: "backend-not-ready" }],
  );
  assert.deepEqual(
    cutoverPreflight({ backendConfigured: true, health: ready(null) }).blockers,
    [{ code: "runtime-detached" }],
  );
});

test("a generation mismatch blocks, and an unpinned expectation has nothing to compare", () => {
  assert.deepEqual(
    cutoverPreflight({ backendConfigured: true, health: ready("gen-b"), expectedGeneration: "gen-a" }).blockers,
    [{ code: "generation-mismatch", detail: "gen-a" }],
  );
  assert.equal(
    cutoverPreflight({ backendConfigured: true, health: ready("gen-b"), expectedGeneration: "  " }).ok,
    true,
  );
});

test("work in flight, Goal Loops and foreign leases each block with a count", () => {
  const result = cutoverPreflight({
    backendConfigured: true,
    health: ready(),
    expectedGeneration: "gen-a",
    activeTasks: [
      { id: "t1", status: "working" },
      { id: "t2", status: "starting" },
      { id: "t3", status: "idle" },
      { id: "t4", status: "ready" },
      { id: "t5", status: "error" },
      { id: "t6", status: "archived" },
    ],
    goalLoopSessions: 2,
    leases: [{ pid: 100 }, { pid: 200 }, { pid: null }, {}],
    ownPid: 100,
  });
  assert.deepEqual(result.blockers, [
    { code: "active-work", detail: 2 },
    { code: "goal-loop-active", detail: 2 },
    { code: "foreign-lease", detail: 3 },
  ]);
  assert.equal(result.activeTasks, 2);
  assert.equal(result.foreignLeases, 3);
  assert.equal(result.ok, false);
});

test("a lease without an owner pid counts as foreign, and this process's own does not", () => {
  // An unidentified owner is not assumed to be us.
  for (const lease of [{ pid: null }, {}]) {
    assert.deepEqual(
      cutoverPreflight({ backendConfigured: true, health: ready(), leases: [lease], ownPid: 1 }).blockers,
      [{ code: "foreign-lease", detail: 1 }],
    );
  }
  assert.equal(cutoverPreflight({ backendConfigured: true, health: ready(), leases: [{ pid: 1 }], ownPid: 1 }).ok, true);
  // Numbers and strings for the same pid are the same owner.
  assert.equal(cutoverPreflight({ backendConfigured: true, health: ready(), leases: [{ pid: "1" }], ownPid: 1 }).ok, true);
  // Without a known own pid, every identified lease is foreign.
  assert.deepEqual(cutoverPreflight({ backendConfigured: true, health: ready(), leases: [{ pid: 1 }] }).blockers, [
    { code: "foreign-lease", detail: 1 },
  ]);
});

test("a second owner, or relaying while this process still owns the runtime, blocks", () => {
  assert.deepEqual(cutoverPreflight({ backendConfigured: true, health: ready(), otherOwner: true }).blockers, [
    { code: "another-owner" },
  ]);
  assert.deepEqual(
    cutoverPreflight({ backendConfigured: true, health: ready(), relayEnabled: true, webOwnsRuntime: true }).blockers,
    [{ code: "mixed-ownership" }],
  );
  // Relaying with the runtime handed over is the intended end state.
  assert.equal(
    cutoverPreflight({ backendConfigured: true, health: ready(), relayEnabled: true, webOwnsRuntime: false }).ok,
    true,
  );
  // The mirror image is half-done too: the Backend owns the runtime but the WebUI serves its own view.
  assert.deepEqual(
    cutoverPreflight({ backendConfigured: true, health: ready(), relayEnabled: false, webOwnsRuntime: false }).blockers,
    [{ code: "relay-disabled" }],
  );
});
