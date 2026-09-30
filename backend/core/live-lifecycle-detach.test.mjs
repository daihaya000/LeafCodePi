import assert from "node:assert/strict";
import { test } from "node:test";
import { detachReplacedLive } from "./live-lifecycle.mjs";

function fixture({ accountId = "acc-1", session = { name: "old" }, snapshotTimer = null, hasTimer = true } = {}) {
  const calls = [];
  const existing = {
    accountId,
    session,
    unsubscribe: () => calls.push("unsubscribe"),
    ...(hasTimer ? { snapshotTimer: snapshotTimer ?? { id: "timer" } } : {}),
  };
  const deps = {
    releaseAccount: (id) => calls.push(`release:${id}`),
    disposeSession: (value) => calls.push(`dispose:${value.name ?? "session"}`),
    clearSnapshotTimer: (timer) => calls.push(`clearTimer:${timer.id}`),
  };
  return { calls, existing, deps };
}

test("there is nothing to detach without a previous live", () => {
  const f = fixture();
  detachReplacedLive(undefined, { name: "new" }, "acc-1", f.deps);
  assert.deepEqual(f.calls, []);
});

test("detaching stops events first, then releases the old account, disposes the old session and cancels the timer", () => {
  const f = fixture();
  detachReplacedLive(f.existing, { name: "new" }, "acc-2", f.deps);
  assert.deepEqual(f.calls, ["unsubscribe", "release:acc-1", "dispose:old", "clearTimer:timer"]);
});

test("the account reference is kept when the replacement runs on the same account", () => {
  const f = fixture();
  detachReplacedLive(f.existing, { name: "new" }, "acc-1", f.deps);
  assert.deepEqual(f.calls, ["unsubscribe", "dispose:old", "clearTimer:timer"]);
  // An account-less live releases nothing either.
  const anonymous = fixture({ accountId: null });
  detachReplacedLive(anonymous.existing, { name: "new" }, "acc-2", anonymous.deps);
  assert.deepEqual(anonymous.calls, ["unsubscribe", "dispose:old", "clearTimer:timer"]);
});

test("re-attaching the very same session does not dispose it", () => {
  const f = fixture();
  detachReplacedLive(f.existing, f.existing.session, "acc-2", f.deps);
  assert.deepEqual(f.calls, ["unsubscribe", "release:acc-1", "clearTimer:timer"]);
});

test("a live without a pending snapshot timer never calls the timer hook", () => {
  const f = fixture({ hasTimer: false });
  detachReplacedLive(f.existing, { name: "new" }, "acc-2", f.deps);
  assert.deepEqual(f.calls, ["unsubscribe", "release:acc-1", "dispose:old"]);
});

test("a failure while releasing the account stops the detach before disposing the session", () => {
  const f = fixture();
  f.deps.releaseAccount = () => { f.calls.push("release:threw"); throw new Error("account manager down"); };
  assert.throws(() => detachReplacedLive(f.existing, { name: "new" }, "acc-2", f.deps), /account manager down/);
  assert.deepEqual(f.calls, ["unsubscribe", "release:threw"]);
});
