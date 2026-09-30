import assert from "node:assert/strict";
import { test } from "node:test";
import { publishAttachedLive } from "./live-lifecycle.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const steps = {
    setUnsubscribe: () => calls.push("setUnsubscribe"),
    markActivity: () => calls.push("markActivity"),
    register: () => calls.push("register"),
    promoteMailbox: () => calls.push("promoteMailbox"),
    ...overrides,
  };
  return { calls, steps };
}

test("publishing runs the four steps in the documented order", () => {
  const f = fixture();
  publishAttachedLive(f.steps);
  assert.deepEqual(f.calls, ["setUnsubscribe", "markActivity", "register", "promoteMailbox"]);
});

test("the mailbox promotion is last, so a wake-up already sees the registered live", () => {
  const seen = [];
  const f = fixture({
    register: () => seen.push("registered"),
    promoteMailbox: () => seen.push(`promote:${seen.includes("registered") ? "after" : "before"}:${seen.includes("activity") ? "" : "no-clock"}`),
  });
  publishAttachedLive({ ...f.steps, markActivity: () => seen.push("activity") });
  assert.deepEqual(seen, ["activity", "registered", "promote:after:"]);
});

test("a failing step propagates and stops the remaining steps", () => {
  const f = fixture({ register: () => { f.calls.push("register"); throw new Error("registry unavailable"); } });
  assert.throws(() => publishAttachedLive(f.steps), /registry unavailable/);
  assert.deepEqual(f.calls, ["setUnsubscribe", "markActivity", "register"]);
});

test("a failing stop hook stops everything after it", () => {
  const f = fixture({ setUnsubscribe: () => { throw new Error("subscribe failed"); } });
  assert.throws(() => publishAttachedLive(f.steps), /subscribe failed/);
  assert.deepEqual(f.calls, []);
});

test("a failing promotion leaves the live registered for the caller to keep or discard", () => {
  const f = fixture({ promoteMailbox: () => { f.calls.push("promoteMailbox"); throw new Error("mailbox down"); } });
  assert.throws(() => publishAttachedLive(f.steps), /mailbox down/);
  assert.deepEqual(f.calls, ["setUnsubscribe", "markActivity", "register", "promoteMailbox"]);
});
