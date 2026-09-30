import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCutoverPreflight, readLeases, readStoreTasks } from "./cutover-preflight.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-cutover-preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the store reader counts only what it can parse, and never writes", (t) => {
  const dir = fixture(t);
  const store = join(dir, "store.json");
  assert.deepEqual(readStoreTasks(store), [], "a missing store has no tasks");
  writeFileSync(store, JSON.stringify({ version: 1, projects: [], tasks: [{ id: "t1", status: "working" }] }), "utf8");
  assert.deepEqual(readStoreTasks(store), [{ id: "t1", status: "working" }]);
  writeFileSync(store, "{not json", "utf8");
  assert.deepEqual(readStoreTasks(store), [], "a broken store is no work, not a crash");
  assert.deepEqual(readStoreTasks(store, { readFile: () => { throw new Error("EACCES"); } }), []);
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
  // A Goal Loop count that cannot be read is zero, not a failure of the whole check.
  const unreadable = await createCutoverPreflight({
    ...base,
    token: "t",
    ownPid: 999,
    countGoalLoops: async () => { throw new Error("offline"); },
  })();
  assert.equal(unreadable.goalLoopSessions, 0);
  assert.equal(unreadable.ok, true, JSON.stringify(unreadable.blockers));
});

test("a preflight without its inputs is refused", () => {
  assert.throws(() => createCutoverPreflight({}), /dataDir is required/);
  assert.throws(() => createCutoverPreflight({ dataDir: "x" }), /readHealth is required/);
});
