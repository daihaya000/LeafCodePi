import assert from "node:assert/strict";
import { test } from "node:test";
import { runTrackedEnsure } from "./live-lifecycle.mjs";

test("the attempt is recorded while it runs and its result is passed through", async () => {
  const inflight = new Map();
  let release;
  const promise = runTrackedEnsure("task", {
    inflight,
    attempt: () => new Promise((resolve) => { release = () => resolve("live"); }),
  });
  assert.equal(inflight.get("task"), promise);
  release();
  assert.equal(await promise, "live");
  assert.equal(inflight.size, 0);
});

test("a failing attempt clears its entry and surfaces the error", async () => {
  const inflight = new Map();
  const promise = runTrackedEnsure("task", {
    inflight,
    attempt: () => Promise.reject(new Error("create failed")),
  });
  await assert.rejects(promise, /create failed/);
  assert.equal(inflight.size, 0);
});

test("a synchronous throw inside the attempt factory still clears nothing stale", async () => {
  const inflight = new Map();
  assert.throws(() => runTrackedEnsure("task", {
    inflight,
    attempt: () => { throw new Error("sync failure"); },
  }), /sync failure/);
  assert.equal(inflight.size, 0, "nothing was registered");
});

test("a newer attempt replaces the entry and the older one does not clear it", async () => {
  const inflight = new Map();
  const resolvers = [];
  const first = runTrackedEnsure("task", { inflight, attempt: () => new Promise((resolve) => resolvers.push(resolve)) });
  const second = runTrackedEnsure("task", { inflight, attempt: () => new Promise((resolve) => resolvers.push(resolve)) });
  assert.equal(inflight.get("task"), second);
  resolvers[0]("first");
  assert.equal(await first, "first");
  assert.equal(inflight.get("task"), second, "the newer attempt stays registered");
  resolvers[1]("second");
  assert.equal(await second, "second");
  assert.equal(inflight.size, 0);
});

test("separate tasks are tracked independently", async () => {
  const inflight = new Map();
  const a = runTrackedEnsure("a", { inflight, attempt: async () => "a" });
  const b = runTrackedEnsure("b", { inflight, attempt: async () => "b" });
  assert.equal(inflight.size, 2);
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.equal(inflight.size, 0);
});

test("the entry is visible to a caller that arrives while the attempt is still running", async () => {
  const inflight = new Map();
  let release;
  const first = runTrackedEnsure("task", { inflight, attempt: () => new Promise((resolve) => { release = resolve; }) });
  const joined = inflight.get("task");
  assert.equal(joined, first, "a second caller would join this promise");
  release("shared");
  assert.equal(await joined, "shared");
  await first;
});
