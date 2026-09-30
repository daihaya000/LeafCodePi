import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEnsureLiveAttempt } from "./live-lifecycle.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const live = { id: "live" };
  const steps = {
    existing: undefined,
    touchExisting: () => calls.push("touch"),
    inflight: undefined,
    afterJoin: () => { calls.push("afterJoin"); return live; },
    isStale: () => { calls.push("stale?"); return false; },
    ...overrides,
  };
  return { calls, live, steps };
}

test("an already registered live is touched and reused without joining anything", async () => {
  const live = { id: "existing" };
  const f = fixture({ existing: live, inflight: Promise.resolve() });
  assert.deepEqual(await resolveEnsureLiveAttempt(f.steps), { action: "reuse", live });
  assert.deepEqual(f.calls, ["touch"]);
});

test("with nothing registered or in flight the caller proceeds", async () => {
  const f = fixture();
  assert.deepEqual(await resolveEnsureLiveAttempt(f.steps), { action: "proceed" });
  assert.deepEqual(f.calls, []);
});

test("the join re-checks the task before looking at what was registered", async () => {
  const order = [];
  const f = fixture({
    inflight: Promise.resolve().then(() => order.push("inflight")),
    afterJoin: () => { order.push("afterJoin"); return { id: "joined" }; },
    isStale: () => { order.push("stale?"); return false; },
  });
  assert.deepEqual(await resolveEnsureLiveAttempt(f.steps), { action: "reuse", live: { id: "joined" } });
  assert.deepEqual(order, ["inflight", "afterJoin", "stale?"]);
});

test("a registered live is adopted after a join while the generation is current", async () => {
  const f = fixture({ inflight: Promise.resolve() });
  const result = await resolveEnsureLiveAttempt(f.steps);
  assert.deepEqual(result, { action: "reuse", live: f.live });
  assert.ok(!f.calls.includes("touch"), "a joined live is not touched here; the reuse path above owns that");
});

test("a stale generation retries instead of adopting the joined live", async () => {
  const f = fixture({ inflight: Promise.resolve(), isStale: () => { f.calls.push("stale?"); return true; } });
  assert.deepEqual(await resolveEnsureLiveAttempt(f.steps), { action: "proceed" });
  assert.ok(f.calls.includes("afterJoin"));
  assert.ok(f.calls.includes("stale?"));
});

test("a join with no live retries", async () => {
  const f = fixture({ inflight: Promise.resolve(), afterJoin: () => { f.calls.push("afterJoin"); return undefined; } });
  assert.deepEqual(await resolveEnsureLiveAttempt(f.steps), { action: "proceed" });
  // The generation is consulted eagerly, matching the original call shape: the read
  // is side-effect free, and `resolveJoinedEnsureAction` ignores it without a live.
  assert.ok(f.calls.includes("stale?"));
  assert.deepEqual(f.calls, ["afterJoin", "stale?"]);
});

test("a failed in-flight attempt propagates to the joiner", async () => {
  const f = fixture({ inflight: Promise.reject(new Error("attempt failed")) });
  await assert.rejects(() => resolveEnsureLiveAttempt(f.steps), /attempt failed/);
  assert.ok(!f.calls.includes("afterJoin"));
});

test("the archived re-check inside the join can throw through this call", async () => {
  const f = fixture({
    inflight: Promise.resolve(),
    afterJoin: () => { throw Object.assign(new Error("タスクが見つかりません"), { status: 404 }); },
  });
  await assert.rejects(() => resolveEnsureLiveAttempt(f.steps), (error) => error.status === 404);
});
