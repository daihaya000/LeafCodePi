import assert from "node:assert/strict";
import { test } from "node:test";
import { runEnsureLiveGates } from "./live-lifecycle.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const steps = {
    isAttachable: () => { calls.push("attachable?"); return true; },
    allowDuringPromotion: false,
    promotion: undefined,
    retirement: undefined,
    ...overrides,
  };
  return { calls, steps };
}

test("an attachable task with nothing in flight proceeds without waiting", async () => {
  const f = fixture();
  assert.equal(await runEnsureLiveGates(f.steps), "continue");
  assert.deepEqual(f.calls, ["attachable?", "attachable?"]);
});

test("an unattachable task stops before any wait", async () => {
  const f = fixture({ isAttachable: () => { f.calls.push("attachable?"); return false; } });
  assert.equal(await runEnsureLiveGates(f.steps), "not-attachable");
  assert.deepEqual(f.calls, ["attachable?"]);
});

test("the promotion is awaited, and the task is re-checked after it", async () => {
  let release = () => {};
  const promotion = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  const f = fixture({
    isAttachable: () => { f.calls.push(`attachable?:${++attempts}`); return attempts === 1; },
    promotion,
  });
  const pending = runEnsureLiveGates(f.steps);
  await Promise.resolve();
  assert.deepEqual(f.calls, ["attachable?:1"], "the second check waits for the promotion");
  release();
  assert.equal(await pending, "not-attachable");
  assert.deepEqual(f.calls, ["attachable?:1", "attachable?:2"]);
});

test("the promotion itself does not wait for itself", async () => {
  const never = new Promise(() => {});
  const f = fixture({ allowDuringPromotion: true, promotion: never });
  assert.equal(await runEnsureLiveGates(f.steps), "continue");
});

test("a failed promotion does not block the next attempt", async () => {
  const f = fixture({ promotion: Promise.reject(new Error("promotion exploded")) });
  assert.equal(await runEnsureLiveGates(f.steps), "continue");
});

test("retirement is awaited after the promotion, and its failure is swallowed", async () => {
  const retired = Promise.reject(new Error("retire exploded"));
  const f = fixture({ promotion: Promise.resolve(), retirement: retired });
  assert.equal(await runEnsureLiveGates(f.steps), "continue");
  const order = [];
  const f2 = fixture({
    promotion: Promise.resolve().then(() => order.push("promotion")),
    retirement: Promise.resolve().then(() => order.push("retirement")),
  });
  assert.equal(await runEnsureLiveGates(f2.steps), "continue");
  assert.deepEqual(order, ["promotion", "retirement"]);
});

test("retirement failure still lets an unattachable verdict win", async () => {
  let attempts = 0;
  const f = fixture({
    isAttachable: () => { f.calls.push(`attachable?:${++attempts}`); return attempts < 2; },
    retirement: Promise.resolve(),
  });
  assert.equal(await runEnsureLiveGates(f.steps), "not-attachable");
});
