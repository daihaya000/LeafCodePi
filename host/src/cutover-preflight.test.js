import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCutoverPreflight, readActiveGoalLoopCount, readLeases, readStoreTasks } from "./cutover-preflight.js";
import { runCutover } from "./cutover.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-cutover-preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the store reader distinguishes known empty from unknown state", (t) => {
  const dir = fixture(t);
  const store = join(dir, "store.json");
  assert.deepEqual(readStoreTasks(store), [], "a missing store has no tasks");
  writeFileSync(store, JSON.stringify({ version: 1, projects: [], tasks: [{ id: "t1", status: "working" }] }), "utf8");
  assert.deepEqual(readStoreTasks(store), [{ id: "t1", status: "working" }]);
  writeFileSync(store, "{not json", "utf8");
  assert.equal(readStoreTasks(store), null, "a broken store is unknown work");
  assert.equal(readStoreTasks(store, { readFile: () => { throw new Error("EACCES"); } }), null);
  for (const tasks of [null, {}, [null], [{ id: "x" }], [{ id: "x", status: "unknown" }], [{ status: "idle" }]]) {
    assert.equal(readStoreTasks(store, { readFile: () => JSON.stringify({ tasks }) }), null);
  }
});

test("the lease reader reports owners, and treats an unreadable lease as unknown", (t) => {
  const dir = fixture(t);
  const leaseDir = join(dir, "task-leases");
  assert.deepEqual(readLeases(leaseDir), [], "a missing directory has no leases");
  mkdirSync(leaseDir, { recursive: true });
  writeFileSync(join(leaseDir, "task-a.json"), JSON.stringify({ token: "x", pid: 4242, acquiredAt: 1, heartbeatAt: 2 }), "utf8");
  writeFileSync(join(leaseDir, "task-b.json"), "{broken", "utf8");
  writeFileSync(join(leaseDir, "notes.txt"), "ignore me", "utf8");
  assert.deepEqual(readLeases(leaseDir).sort((a, b) => a.taskId.localeCompare(b.taskId)), [
    { taskId: "task-a", pid: 4242 },
    { taskId: "task-b", pid: null },
  ]);
});

test("the start phase accepts a detached Backend and refuses when work is running", async (t) => {
  const dir = fixture(t);
  writeFileSync(
    join(dir, "store.json"),
    JSON.stringify({ version: 1, tasks: [{ id: "t1", status: "working" }, { id: "t2", status: "ready" }] }),
    "utf8",
  );
  const preflight = createCutoverPreflight({
    dataDir: dir,
    token: "t".repeat(40),
    ownPid: 100,
    readHealth: async () => ({ ok: true, ready: false, generation: { pinned: "gen-a", running: null, matches: false } }),
    countGoalLoops: async () => 1,
  });
  const result = await preflight();
  assert.equal(result.phase, "start");
  assert.deepEqual(result.blockers, [
    { code: "active-work", detail: 1 },
    { code: "goal-loop-active", detail: 1 },
  ]);
});

test("an idle Host with a reachable detached Backend may start the cutover", async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "store.json"), JSON.stringify({ version: 1, tasks: [{ id: "t1", status: "idle" }] }), "utf8");
  const preflight = createCutoverPreflight({
    dataDir: dir,
    token: "t".repeat(40),
    ownPid: 100,
    readHealth: async () => ({ ok: true, ready: false }),
    countGoalLoops: async () => 0,
  });
  const result = await preflight();
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  assert.equal(result.activeTasks, 0);
});

test("a foreign lease, an unreachable Backend and a missing token each block", async (t) => {
  const dir = fixture(t);
  mkdirSync(join(dir, "task-leases"), { recursive: true });
  writeFileSync(join(dir, "task-leases", "task-a.json"), JSON.stringify({ pid: 999 }), "utf8");
  const base = {
    dataDir: dir,
    ownPid: 100,
    readHealth: async () => ({ ok: true, ready: false }),
    countGoalLoops: async () => 0,
  };
  const withToken = await createCutoverPreflight({ ...base, token: "t" })();
  assert.deepEqual(withToken.blockers, [{ code: "foreign-lease", detail: 1 }]);
  const noToken = await createCutoverPreflight(base)();
  assert.deepEqual(noToken.blockers, [{ code: "backend-not-configured" }, { code: "foreign-lease", detail: 1 }]);
  const unreachable = await createCutoverPreflight({
    ...base,
    token: "t",
    readHealth: async () => ({ ok: false, reason: "unreachable" }),
  })();
  assert.deepEqual(unreachable.blockers, [{ code: "backend-unreachable" }, { code: "foreign-lease", detail: 1 }]);
  // A failed Goal Loop observation is unknown, even if all other inputs are idle.
  const unreadable = await createCutoverPreflight({
    ...base,
    token: "t",
    ownPid: 999,
    countGoalLoops: async () => { throw new Error("offline"); },
  })();
  assert.equal(unreadable.goalLoopSessions, null);
  assert.equal(unreadable.ok, false);
  assert.deepEqual(unreadable.blockers, [{ code: "goal-loop-state-unknown" }]);
});

test("a corrupt store refuses cutover instead of being treated as idle", async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "store.json"), "{broken", "utf8");
  const result = await createCutoverPreflight({
    dataDir: dir, token: "t", readHealth: async () => ({ ok: true, ready: false }), countGoalLoops: async () => 0,
  })();
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, [{ code: "store-state-unknown" }]);
  assert.equal(result.activeTasks, null);
});

test("a failed Goal Loop observation refuses cutover", async (t) => {
  const dir = fixture(t);
  const result = await createCutoverPreflight({
    dataDir: dir, token: "t", readHealth: async () => ({ ok: true, ready: false }),
    countGoalLoops: async () => { throw new Error("offline private details"); },
  })();
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, [{ code: "goal-loop-state-unknown" }]);
  assert.equal(result.goalLoopSessions, null);
});

test("lease listing and store permission failures refuse cutover", async (t) => {
  const dir = fixture(t);
  const base = { dataDir: dir, token: "t", readHealth: async () => ({ ok: true, ready: false }), countGoalLoops: () => 0 };
  const denied = () => { throw Object.assign(new Error("private details"), { code: "EACCES" }); };
  const store = await createCutoverPreflight({ ...base, readers: { readFile: denied } })();
  assert.deepEqual(store.blockers, [{ code: "store-state-unknown" }]);
  const leases = await createCutoverPreflight({ ...base, readers: { readdir: denied } })();
  assert.deepEqual(leases.blockers, [{ code: "lease-state-unknown" }]);
  assert.equal(leases.foreignLeases, null);
  assert.equal(JSON.stringify([store, leases]).includes("private details"), false);
});

test("missing, malformed or synchronously failed Goal Loop observations are unknown", async (t) => {
  const dir = fixture(t);
  const base = { dataDir: dir, token: "t", readHealth: async () => ({ ok: true, ready: false }) };
  for (const observed of [null, undefined, "0", false, -1, 0.5, NaN, Infinity, {}]) {
    const result = await createCutoverPreflight({ ...base, countGoalLoops: () => observed })();
    assert.equal(result.ok, false);
    assert.deepEqual(result.blockers, [{ code: "goal-loop-state-unknown" }]);
    assert.equal(result.goalLoopSessions, null);
  }
  const missing = await createCutoverPreflight(base)();
  assert.equal(missing.ok, false);
  const synchronousFailure = await createCutoverPreflight({ ...base, countGoalLoops: () => { throw new Error("offline"); } })();
  assert.deepEqual(synchronousFailure.blockers, [{ code: "goal-loop-state-unknown" }]);
});

test("unobserved work stops the cutover before any process effects", async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "store.json"), "{broken", "utf8");
  const calls = [];
  const effect = async () => { calls.push("effect"); };
  const result = await runCutover({
    preflight: createCutoverPreflight({ dataDir: dir, token: "t", readHealth: async () => ({ ok: true, ready: false }) }),
    stopWebUi: effect, startWebUi: effect, stopBackend: effect, startBackendAttached: effect, waitReady: effect,
  });
  assert.equal(result.stage, "check");
  assert.equal(result.rolledBack, false);
  assert.deepEqual(result.blockers, [{ code: "store-state-unknown" }, { code: "goal-loop-state-unknown" }]);
  assert.deepEqual(calls, []);
});

test("the HTTP Goal Loop reader preserves valid counts and authentication", async () => {
  for (const active of [0, 3]) {
    let call;
    const observed = await readActiveGoalLoopCount({
      baseUrl: "http://127.0.0.1:3010/", token: "test-token",
      fetchImpl: async (url, options) => {
        call = { url, options };
        return { ok: true, json: async () => ({ active }) };
      },
    });
    assert.equal(observed, active);
    assert.equal(call.url, "http://127.0.0.1:3010/api/goal-loop/active");
    assert.equal(call.options.headers.authorization, "Bearer test-token");
    assert.equal(call.options.cache, "no-store");
  }
});

test("the HTTP Goal Loop reader never converts unavailable or invalid data to zero", async () => {
  const options = { baseUrl: "http://127.0.0.1:3010" };
  for (const active of [undefined, null, "0", false, -1, 0.5, NaN, Infinity]) {
    assert.equal(await readActiveGoalLoopCount({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ active }) }) }), null);
  }
  assert.equal(await readActiveGoalLoopCount({ ...options, fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await readActiveGoalLoopCount({ ...options, fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(await readActiveGoalLoopCount({ ...options, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }) }), null);
});

test("a preflight without its inputs is refused", () => {
  assert.throws(() => createCutoverPreflight({}), /dataDir is required/);
  assert.throws(() => createCutoverPreflight({ dataDir: "x" }), /readHealth is required/);
});
