import assert from "node:assert/strict";
import { test } from "node:test";
import { runSerializedByKey } from "./keyed-serializer.mjs";

test("a single call runs the action and clears its entry", async () => {
  const inflight = new Map();
  const result = await runSerializedByKey(inflight, "a", async () => "done");
  assert.equal(result, "done");
  assert.equal(inflight.size, 0);
});

test("the entry is recorded while the action runs and while it waits", async () => {
  const inflight = new Map();
  let releaseFirst;
  const first = runSerializedByKey(inflight, "a", () => new Promise((resolve) => { releaseFirst = resolve; }));
  assert.equal(inflight.size, 1);
  // The action starts after the (resolved) previous holder is awaited.
  await new Promise((resolve) => setImmediate(resolve));
  const second = runSerializedByKey(inflight, "a", async () => "second");
  assert.equal(inflight.size, 1, "the newer holder replaces the entry");
  releaseFirst("first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.equal(inflight.size, 0);
});

test("work for one key is serialized, in arrival order", async () => {
  const inflight = new Map();
  const order = [];
  const slow = () => new Promise((resolve) => setTimeout(() => { order.push("first"); resolve(); }, 20));
  const quick = async () => { order.push("second"); };
  await Promise.all([
    runSerializedByKey(inflight, "same", slow),
    runSerializedByKey(inflight, "same", quick),
  ]);
  assert.deepEqual(order, ["first", "second"]);
});

test("different keys run concurrently", async () => {
  const inflight = new Map();
  const order = [];
  await Promise.all([
    runSerializedByKey(inflight, "a", async () => { order.push("a-start"); await new Promise((resolve) => setTimeout(resolve, 20)); order.push("a-end"); }),
    runSerializedByKey(inflight, "b", async () => { order.push("b-start"); order.push("b-end"); }),
  ]);
  assert.deepEqual(order, ["a-start", "b-start", "b-end", "a-end"]);
  assert.equal(inflight.size, 0);
});

test("a failing action still releases the chain for the next caller", async () => {
  const inflight = new Map();
  const failing = runSerializedByKey(inflight, "a", async () => { throw new Error("action failed"); });
  await assert.rejects(failing, /action failed/);
  assert.equal(inflight.size, 0);
  assert.equal(await runSerializedByKey(inflight, "a", async () => "next"), "next");
});

test("an older holder does not delete the entry of a newer one", async () => {
  const inflight = new Map();
  const resolvers = [];
  const first = runSerializedByKey(inflight, "a", () => new Promise((resolve) => resolvers.push(resolve)));
  const second = runSerializedByKey(inflight, "a", () => new Promise((resolve) => resolvers.push(resolve)));
  await new Promise((resolve) => setImmediate(resolve));
  const holder = inflight.get("a");
  resolvers[0]("first");
  await first;
  assert.equal(inflight.get("a"), holder, "the newer chain entry survives the older release");
  await new Promise((resolve) => setImmediate(resolve));
  resolvers[1]("second");
  await second;
  assert.equal(inflight.size, 0);
});

test("the previous holder is awaited even when it was replaced", async () => {
  const inflight = new Map();
  const order = [];
  const slow = runSerializedByKey(inflight, "a", async () => { await new Promise((resolve) => setTimeout(resolve, 10)); order.push("slow"); });
  const faster = runSerializedByKey(inflight, "a", async () => { order.push("faster"); });
  await Promise.all([slow, faster]);
  assert.deepEqual(order, ["slow", "faster"]);
});
