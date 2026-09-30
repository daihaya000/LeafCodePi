import assert from "node:assert/strict";
import { test } from "node:test";
import { findStaleRoomTurns, runRoomReconcile } from "./room-recovery.mjs";

const STALE = 1_000;
const NOW = 10_000;
const old = NOW - STALE - 1;

function staleFixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    options: {
      now: NOW, staleMs: STALE,
      taskIdFor: (botId) => { calls.push(`task:${botId}`); return `room:${botId}`; },
      isRunOwned: () => false, hasActiveLease: () => false, getTask: () => undefined,
      ...overrides,
    },
  };
}

test("only working placeholders older than the threshold are candidates", () => {
  const f = staleFixture();
  const messages = [
    { id: "done", status: "done", createdAt: 0, botId: "a" },
    { id: "fresh", status: "working", createdAt: NOW - STALE, botId: null },
    { id: "boundary-old", status: "working", createdAt: old },
    { id: "error", status: "error", createdAt: 0 },
  ];
  assert.deepEqual(findStaleRoomTurns(messages, f.options).map((m) => m.id), ["boundary-old"]);
});

test("a Bot-less placeholder is stale by age alone and never consults tasks or leases", () => {
  const f = staleFixture({ isRunOwned: () => { throw new Error("unreachable"); }, hasActiveLease: () => { throw new Error("unreachable"); } });
  assert.equal(findStaleRoomTurns([{ id: "m", status: "working", createdAt: old }], f.options).length, 1);
  assert.deepEqual(f.calls, []);
});

test("a slow Bot turn is kept when this worker owns it, another worker leases it, or the task is still moving", () => {
  const message = { id: "m", status: "working", createdAt: old, botId: "a" };
  assert.equal(findStaleRoomTurns([message], staleFixture({ isRunOwned: (id) => id === "room:a" }).options).length, 0);
  assert.equal(findStaleRoomTurns([message], staleFixture({ hasActiveLease: (id) => id === "room:a" }).options).length, 0);
  assert.equal(findStaleRoomTurns([message], staleFixture({ getTask: () => ({ status: "working", updatedAt: new Date(NOW - STALE).toISOString() }) }).options).length, 0);
});

test("a Bot turn is abandoned when its task is idle, old, missing or has an unparsable timestamp", () => {
  const message = { id: "m", status: "working", createdAt: old, botId: "a" };
  const working = (updatedAt, status = "working") => staleFixture({ getTask: () => ({ status, updatedAt }) }).options;
  assert.equal(findStaleRoomTurns([message], working(new Date(NOW - STALE - 1).toISOString())).length, 1);
  assert.equal(findStaleRoomTurns([message], working(new Date(NOW).toISOString(), "idle")).length, 1);
  assert.equal(findStaleRoomTurns([message], working("not a date")).length, 1);
  assert.equal(findStaleRoomTurns([message], staleFixture({ getTask: () => null }).options).length, 1);
});

test("ownership checks run in order: owned run, then lease, then the task record", () => {
  const order = [];
  const f = staleFixture({
    isRunOwned: () => { order.push("owned"); return false; },
    hasActiveLease: () => { order.push("lease"); return false; },
    getTask: () => { order.push("task"); return undefined; },
  });
  findStaleRoomTurns([{ id: "m", status: "working", createdAt: old, botId: "a" }], f.options);
  assert.deepEqual(order, ["owned", "lease", "task"]);
});

function reconcileFixture(overrides = {}) {
  const events = [];
  const warnings = [];
  return {
    events, warnings,
    deps: {
      listRooms: () => [{ id: "r1" }, { id: "r2" }],
      settleStaleTurns: (id) => events.push(`stale:${id}`),
      settleHandoffs: () => 0,
      deliverHandoffs: (id) => { events.push(`deliver:${id}`); return Promise.resolve(); },
      warn: (...args) => warnings.push(args),
      ...overrides,
    },
  };
}

test("startup settles stale turns then handoffs per room, delivering only when handoffs were settled", () => {
  const events = [];
  const f = reconcileFixture({
    settleStaleTurns: (id) => events.push(`stale:${id}`),
    settleHandoffs: (id) => { events.push(`handoffs:${id}`); return id === "r2" ? 2 : 0; },
    deliverHandoffs: (id) => { events.push(`deliver:${id}`); return Promise.resolve(); },
  });
  runRoomReconcile(f.deps);
  assert.deepEqual(events, ["stale:r1", "handoffs:r1", "stale:r2", "handoffs:r2", "deliver:r2"]);
});

test("a failed delivery (rejected Error or plain value) is only warned and does not stop later rooms", async () => {
  const f = reconcileFixture({
    listRooms: () => [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
    settleHandoffs: () => 1,
    deliverHandoffs: (id) => {
      if (id === "r1") return Promise.reject(new Error("delivery failed"));
      if (id === "r2") return Promise.reject("plain failure");
      return Promise.resolve();
    },
  });
  runRoomReconcile(f.deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.warnings, [
    ["[room-runtime] startup handoff recovery failed:", "delivery failed"],
    ["[room-runtime] startup handoff recovery failed:", "plain failure"],
  ]);
});

test("store failures while settling are not swallowed", () => {
  const f = reconcileFixture({ settleStaleTurns: () => { throw new Error("room store unreadable"); } });
  assert.throws(() => runRoomReconcile(f.deps), /room store unreadable/);
});

test("an empty room list does nothing", () => {
  const f = reconcileFixture({ listRooms: () => [] });
  runRoomReconcile(f.deps);
  assert.deepEqual(f.events, []);
});
