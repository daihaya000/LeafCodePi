import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { RuntimeStartup, SESSION_LABEL_BACKFILL_DELAY_MS } from "./runtime-startup.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(overrides = {}) {
  const order = [];
  const scheduled = [];
  const warnings = [];
  const services = {
    registerRestartResume: () => { order.push("listener"); },
    reconcileOrphanedWorkingTasks: () => { order.push("orphans"); },
    startBotCodeRelay: () => { order.push("relay"); },
    ensureRoutineScheduler: () => { order.push("routines"); },
    reconcileRoomRuntime: () => { order.push("rooms"); },
    warmTaskSummaries: () => { order.push("tasks"); },
    warmModels: () => { order.push("models"); },
    backfillMissingTaskLabels: () => { order.push("labels"); },
    ...overrides,
  };
  let loads = 0;
  const startup = new RuntimeStartup({
    loadServices: () => { loads += 1; return services; },
    warn: (...args) => { warnings.push(args); },
    schedule: (callback, delayMs) => {
      const item = { callback, delayMs, cancelled: false };
      scheduled.push(item);
      return () => { item.cancelled = true; };
    },
  });
  return { startup, services, order, scheduled, warnings, loads: () => loads };
}

test("startup is lazy and concurrent calls share one initialization", async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const f = fixture({ registerRestartResume: async () => { f.order.push("listener"); await gate; } });
  assert.equal(f.loads(), 0);
  const first = f.startup.start();
  assert.equal(first, f.startup.start());
  await tick();
  assert.deepEqual(f.order, ["listener"]);
  finish();
  await first;
  await tick();
  assert.deepEqual(f.order, ["listener", "orphans", "relay", "routines", "rooms", "tasks", "models"]);
  assert.equal(f.loads(), 1);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0].delayMs, SESSION_LABEL_BACKFILL_DELAY_MS);
  assert.equal(first, f.startup.start());
  f.scheduled[0].callback();
  await tick();
  assert.equal(f.order.at(-1), "labels");
});

test("required startup does not wait for optional warmups", async () => {
  const f = fixture({ warmModels: () => new Promise(() => {}) });
  await f.startup.start();
  assert.ok(f.order.includes("rooms"));
  assert.equal(f.scheduled.length, 1);
  f.startup.cancelWarmups();
});

test("listener failure is warned but reconciliation and services still start", async () => {
  const failure = new Error("listener unavailable");
  const f = fixture({ registerRestartResume: () => { throw failure; } });
  await f.startup.start();
  assert.deepEqual(f.warnings, [["[restart-resume] unavailable", failure]]);
  assert.deepEqual(f.order.slice(0, 4), ["orphans", "relay", "routines", "rooms"]);
});

test("both synchronous and asynchronous warmup failures remain nonfatal", async () => {
  const f = fixture({
    warmTaskSummaries: () => { throw new Error("task cache failed"); },
    warmModels: () => Promise.reject(new Error("models unavailable")),
    backfillMissingTaskLabels: () => Promise.reject(new Error("labels unavailable")),
  });
  await f.startup.start();
  f.scheduled[0].callback();
  await tick();
  assert.deepEqual(f.order, ["listener", "orphans", "relay", "routines", "rooms"]);
  assert.equal(f.warnings.length, 0);
});

test("dependency loading failure clears the promise for retry", async () => {
  const f = fixture();
  let attempts = 0;
  const startup = new RuntimeStartup({
    loadServices: () => {
      if (++attempts === 1) throw new Error("loading failed");
      return f.services;
    },
    schedule: () => () => {},
  });
  const first = startup.start();
  await assert.rejects(first, /loading failed/);
  const retry = startup.start();
  assert.notEqual(first, retry);
  await retry;
  assert.equal(attempts, 2);
  assert.equal(f.order.filter((step) => step === "relay").length, 1);
});

test("required reconciliation failure prevents relay and warmups, and can be retried", async () => {
  let attempts = 0;
  const f = fixture({ reconcileOrphanedWorkingTasks: () => {
    if (++attempts === 1) throw new Error("store unavailable");
    f.order.push("orphans");
  } });
  await assert.rejects(f.startup.start(), /store unavailable/);
  assert.deepEqual(f.order, ["listener"]);
  assert.equal(f.scheduled.length, 0);
  await f.startup.start();
  assert.equal(f.order.filter((step) => step === "relay").length, 1);
  assert.equal(f.scheduled.length, 1);
});

test("plain Node startup needs no Next/SDK and a delayed backfill does not keep the process alive", () => {
  const moduleUrl = new URL("./runtime-startup.mjs", import.meta.url).href;
  const code = `
    import { RuntimeStartup } from ${JSON.stringify(moduleUrl)};
    const order = [];
    const startup = new RuntimeStartup({ loadServices: () => ({
      registerRestartResume: () => order.push("listener"),
      reconcileOrphanedWorkingTasks: () => order.push("orphans"),
      startBotCodeRelay: () => order.push("relay"),
      ensureRoutineScheduler: () => order.push("routines"),
      reconcileRoomRuntime: () => order.push("rooms"),
      backfillMissingTaskLabels: () => { throw new Error("must remain delayed"); },
    }) });
    await startup.start();
    console.log(JSON.stringify(order));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
  assert.deepEqual(JSON.parse(output), ["listener", "orphans", "relay", "routines", "rooms"]);
});

test("cancelling warmups cancels the delayed label timer without stopping services", async () => {
  const f = fixture();
  await f.startup.start();
  f.startup.cancelWarmups();
  f.startup.cancelWarmups();
  assert.equal(f.scheduled[0].cancelled, true);
  // A timer already queued before cancellation must not invoke the label worker.
  f.scheduled[0].callback();
  await tick();
  assert.ok(!f.order.includes("labels"));
  assert.equal(f.order.filter((step) => step === "relay").length, 1);
  await f.startup.start();
  assert.equal(f.scheduled.length, 1);
});

test("an attached runtime runs first, before the services that need it", async () => {
  const order = [];
  const services = {
    loadRuntime: async () => { order.push("loadRuntime"); },
    registerRestartResume: () => { order.push("registerRestartResume"); },
    reconcileOrphanedWorkingTasks: () => { order.push("reconcile"); },
    startBotCodeRelay: () => { order.push("relay"); },
    ensureRoutineScheduler: () => { order.push("routines"); },
    reconcileRoomRuntime: () => { order.push("rooms"); },
  };
  await new RuntimeStartup({ loadServices: () => services, warn: () => {} }).start();
  assert.deepEqual(order, ["loadRuntime", "registerRestartResume", "reconcile", "relay", "routines", "rooms"]);
});

test("a failing runtime attach stops the sequence so the caller can retry", async () => {
  const order = [];
  const services = {
    loadRuntime: async () => { order.push("loadRuntime"); throw new Error("no runtime"); },
    registerRestartResume: () => { order.push("registerRestartResume"); },
    reconcileOrphanedWorkingTasks: () => { order.push("reconcile"); },
    startBotCodeRelay: () => {},
    ensureRoutineScheduler: () => {},
    reconcileRoomRuntime: () => {},
  };
  const startup = new RuntimeStartup({ loadServices: () => services, warn: () => {} });
  await assert.rejects(() => startup.start(), /no runtime/);
  assert.deepEqual(order, ["loadRuntime"], "nothing after a failed attach runs");
});

test("a startup without a runtime step is unchanged", async () => {
  const order = [];
  const services = {
    registerRestartResume: () => { order.push("registerRestartResume"); },
    reconcileOrphanedWorkingTasks: () => { order.push("reconcile"); },
    startBotCodeRelay: () => {},
    ensureRoutineScheduler: () => {},
    reconcileRoomRuntime: () => {},
  };
  await new RuntimeStartup({ loadServices: () => services, warn: () => {} }).start();
  assert.deepEqual(order, ["registerRestartResume", "reconcile"]);
});
