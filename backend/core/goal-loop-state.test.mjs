import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GoalLoopStateStore } from "./goal-loop-state.mjs";

const clampMaxTurns = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 10);
const clampCooldownSeconds = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0);

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new GoalLoopStateStore({
    dataDir: () => root, clampMaxTurns, clampCooldownSeconds, ...overrides,
  });
  const write = (sessionId, value) => {
    const dir = join(root, "goals-loop");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.json`);
    writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, "utf8");
    return file;
  };
  return { root, store, write };
}

test("the state file lives under the data directory, keyed by a sanitized session id", (t) => {
  const f = fixture(t);
  assert.equal(f.store.stateFile("C:/ignored", "session-1"), join(f.root, "goals-loop", "session-1.json"));
  // Ids that need sanitizing get a digest suffix (same as the extension), so "a/b" and "a?b" never share a file.
  const odd = f.store.stateFile("C:/ignored", "a/b\\c d");
  assert.match(odd, /a_b_c_d-[0-9a-f]{16}\.json$/);
  assert.notEqual(f.store.stateFile("", "a/b"), f.store.stateFile("", "a?b"));
  assert.equal(f.store.stateFile("", ""), join(f.root, "goals-loop", "session.json"));
  assert.match(f.store.stateFile("", "x".repeat(200)), new RegExp(`${"x".repeat(100)}-[0-9a-f]{16}\\.json$`));
});

test("a state file under the legacy sanitized name is still read, but never another session's", (t) => {
  const f = fixture(t);
  const state = (extra = {}) => ({ goal: "ship", status: "running", ...extra });
  f.write("a_b", state({ sessionId: "a/b" }));
  assert.equal(f.store.read("", "a/b")?.goal, "ship");
  // The same legacy file belongs to "a/b"; "a?b" must not adopt it.
  assert.equal(f.store.read("", "a?b"), null);
  // Pre-sessionId snapshots stay readable because their owner is unknown.
  f.write("c_d", state());
  assert.equal(f.store.read("", "c/d")?.goal, "ship");
  // The isolated name wins once it exists.
  const isolated = f.store.stateFile("", "a/b");
  writeFileSync(isolated, `${JSON.stringify(state({ sessionId: "a/b", goal: "new" }))}\n`, "utf8");
  assert.equal(f.store.read("", "a/b")?.goal, "new");
});

test("a missing session id or unreadable file reads as null and caches nothing", (t) => {
  const f = fixture(t);
  assert.equal(f.store.read("", null), null);
  assert.equal(f.store.read("", undefined), null);
  assert.equal(f.store.read("", "absent"), null);
  assert.equal(f.store.cache.size, 0);
  f.write("broken", "{not json");
  assert.equal(f.store.read("", "broken"), null);
  assert.equal(f.store.cache.size, 0);
});

test("a state file without a goal or status is rejected, not partially trusted", (t) => {
  const f = fixture(t);
  f.write("no-goal", { status: "running" });
  f.write("no-status", { goal: "ship" });
  f.write("array", [1, 2]);
  for (const id of ["no-goal", "no-status", "array"]) assert.equal(f.store.read("", id), null, id);
});

test("a read normalizes the numeric and list fields the panel relies on", (t) => {
  const f = fixture(t);
  f.write("state", {
    goal: "ship", status: "running", maxTurns: 3.9, cooldownSeconds: "120", nextTurnAt: 5,
    unreadableStreak: -2, progress: "nope", turnCount: 4.7, extra: "kept",
  });
  assert.deepEqual(f.store.read("", "state"), {
    goal: "ship", status: "running", maxTurns: 3, cooldownSeconds: 120, nextTurnAt: null,
    unreadableStreak: 0, progress: [], turnCount: 4, extra: "kept",
  });
  f.write("other", { goal: "g", status: "paused", nextTurnAt: "2026-01-01T00:00:00.000Z", progress: [{ at: 1 }], turnCount: 2 });
  assert.deepEqual(f.store.read("", "other"), {
    goal: "g", status: "paused", maxTurns: 10, cooldownSeconds: 0,
    nextTurnAt: "2026-01-01T00:00:00.000Z", unreadableStreak: 0, progress: [{ at: 1 }], turnCount: 2,
  });
});

test("a cached entry is reused while the file is unchanged", (t) => {
  const f = fixture(t);
  f.write("cached", { goal: "g", status: "running" });
  const first = f.store.read("", "cached");
  assert.equal(f.store.read("", "cached"), first, "same object while mtime/size/inode match");
});

test("a replaced file is re-read because the inode or mtime changed", (t) => {
  const f = fixture(t);
  const file = f.write("replaced", { goal: "before", status: "running" });
  f.store.read("", "replaced");
  // A same-size edit with a distinct mtime must be noticed.
  writeFileSync(file, `${JSON.stringify({ goal: "after", status: "paused" })}\n`, "utf8");
  utimesSync(file, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
  assert.equal(f.store.read("", "replaced").goal, "after");
  // A file that becomes malformed invalidates its entry instead of serving stale state.
  writeFileSync(file, "{broken", "utf8");
  utimesSync(file, new Date(Date.now() + 4_000), new Date(Date.now() + 4_000));
  assert.equal(f.store.read("", "replaced"), null);
  assert.equal(f.store.cache.size, 0);
});

test("the cache is bounded and evicts the oldest entry first", (t) => {
  const f = fixture(t, { maxCacheEntries: 2 });
  for (const id of ["a", "b", "c"]) f.write(id, { goal: "g", status: "running" });
  f.store.read("", "a");
  f.store.read("", "b");
  f.store.read("", "c");
  assert.equal(f.store.cache.size, 2);
  assert.equal(f.store.cache.has(join(f.root, "goals-loop", "a.json")), false, "the oldest entry was evicted");
  assert.equal(f.store.cache.has(join(f.root, "goals-loop", "c.json")), true);
  // An entry that is re-read is re-inserted, so the newest entries survive.
  f.store.read("", "c");
  f.store.read("", "b");
  assert.equal(f.store.cache.size, 2);
});

test("invalidate drops a single entry", (t) => {
  const f = fixture(t);
  const file = f.write("gone", { goal: "g", status: "running" });
  f.store.read("", "gone");
  assert.equal(f.store.cache.size, 1);
  f.store.invalidate(file);
  assert.equal(f.store.cache.size, 0);
});

test("operator holds are the user-initiated pauses only", () => {
  for (const pauseReason of ["user", "manual_send"]) {
    assert.equal(GoalLoopStateStore.isOperatorHold({ status: "paused", pauseReason }), true, pauseReason);
  }
  for (const pauseReason of ["turn_limit", "session_end", "", null, undefined, "other"]) {
    assert.equal(GoalLoopStateStore.isOperatorHold({ status: "paused", pauseReason }), false, String(pauseReason));
  }
  for (const status of ["running", "blocked", "queued", null, undefined]) {
    assert.equal(GoalLoopStateStore.isOperatorHold({ status, pauseReason: "user" }), false, String(status));
  }
  assert.equal(GoalLoopStateStore.isOperatorHold(null), false);
  assert.equal(GoalLoopStateStore.isOperatorHold(undefined), false);
});
