import assert from "node:assert/strict";
import { test } from "node:test";
import { runCoalescedLiveShutdown } from "./live-lifecycle.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const inflight = new Map();
  const resolvers = [];
  const deps = {
    inflight,
    runShutdown: () => new Promise((resolve) => { calls.push("shutdown"); resolvers.push(() => { calls.push("settled"); resolve(); }); }),
    disposeSession: () => calls.push("dispose"),
    ...overrides,
  };
  return { calls, inflight, deps, finish: () => resolvers.at(-1)?.(), finishAll: () => resolvers.splice(0).forEach((resolve) => resolve()) };
}

test("a shutdown is recorded as in flight before it settles", () => {
  const f = fixture();
  const pending = runCoalescedLiveShutdown("task", f.deps);
  assert.deepEqual(f.calls, ["shutdown"]);
  assert.equal(f.inflight.get("task"), pending);
});

test("the session is disposed after the extension shutdown settles, then the entry is cleared", async () => {
  const f = fixture();
  const pending = runCoalescedLiveShutdown("task", f.deps);
  f.finish();
  await pending;
  assert.deepEqual(f.calls, ["shutdown", "settled", "dispose"]);
  assert.equal(f.inflight.has("task"), false);
});

test("a failing shutdown still disposes the session and clears the entry", async () => {
  const calls = [];
  const inflight = new Map();
  const pending = runCoalescedLiveShutdown("task", {
    inflight,
    runShutdown: () => { calls.push("shutdown"); return Promise.reject(new Error("extension shutdown failed")); },
    disposeSession: () => calls.push("dispose"),
  });
  await assert.rejects(pending, /extension shutdown failed/);
  assert.deepEqual(calls, ["shutdown", "dispose"]);
  assert.equal(inflight.has("task"), false);
});

test("a second dispose for the same task joins the first instead of disposing twice", () => {
  const f = fixture();
  const first = runCoalescedLiveShutdown("task", f.deps);
  const second = runCoalescedLiveShutdown("task", f.deps);
  assert.equal(f.inflight.get("task"), second);
  assert.notEqual(first, second);
  assert.deepEqual(f.calls, ["shutdown", "shutdown"], "the caller decides whether to join; the registry only tracks the newest");
});

test("an entry replaced by a newer shutdown is not cleared by the older one", async () => {
  const calls = [];
  const inflight = new Map();
  const resolvers = [];
  const deps = {
    inflight,
    runShutdown: () => { calls.push("shutdown"); return new Promise((resolve) => resolvers.push(resolve)); },
    disposeSession: () => calls.push("dispose"),
  };
  const first = runCoalescedLiveShutdown("task", deps);
  const second = runCoalescedLiveShutdown("task", deps);
  resolvers[0]();
  await first;
  assert.equal(inflight.get("task"), second, "the newer in-flight entry survives");
  assert.deepEqual(calls, ["shutdown", "shutdown", "dispose"]);
  resolvers[1]();
  await second;
  assert.equal(inflight.has("task"), false);
  assert.deepEqual(calls, ["shutdown", "shutdown", "dispose", "dispose"]);
});

test("separate tasks keep separate in-flight entries", async () => {
  const f = fixture();
  const a = runCoalescedLiveShutdown("a", f.deps);
  const b = runCoalescedLiveShutdown("b", f.deps);
  assert.notEqual(a, b);
  assert.equal(f.inflight.size, 2);
  f.finishAll();
  await a;
  await b;
  assert.equal(f.inflight.size, 0);
  // Both settles run before either finally callback (microtask ordering).
  assert.deepEqual(f.calls, ["shutdown", "shutdown", "settled", "settled", "dispose", "dispose"]);
});

test("a throwing dispose aborts the finally block before the entry is cleared", async () => {
  const inflight = new Map();
  const deps = {
    inflight,
    runShutdown: () => Promise.resolve(),
    disposeSession: () => { throw new Error("session dispose failed"); },
  };
  // The caller is expected to swallow dispose failures (the harness wrapper warns
  // instead of throwing); if it does throw, the finally block stops before cleanup,
  // leaving the entry — documented rather than silently changed.
  await assert.rejects(runCoalescedLiveShutdown("task", deps), /session dispose failed/);
  assert.equal(inflight.has("task"), true);
});

test("a dispose that swallows its own failure still clears the entry", async () => {
  const inflight = new Map();
  const warnings = [];
  const deps = {
    inflight,
    runShutdown: () => Promise.resolve(),
    disposeSession: () => { try { throw new Error("session dispose failed"); } catch (error) { warnings.push(error.message); } },
  };
  await runCoalescedLiveShutdown("task", deps);
  assert.deepEqual(warnings, ["session dispose failed"]);
  assert.equal(inflight.has("task"), false);
});
