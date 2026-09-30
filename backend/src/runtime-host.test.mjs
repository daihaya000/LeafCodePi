import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeHost } from "./runtime-host.mjs";

function fakeStartup(behaviour = () => Promise.resolve()) {
  const calls = { start: 0, cancel: 0 };
  return {
    calls,
    start: () => { calls.start += 1; return behaviour(calls.start); },
    cancelWarmups: () => { calls.cancel += 1; },
  };
}

const quiet = () => undefined;

test("construction is inert and not ready; a startup without start() is rejected", () => {
  const startup = fakeStartup();
  const host = createRuntimeHost({ startup, warn: quiet });
  assert.equal(host.isReady(), false);
  assert.equal(host.status(), "idle");
  assert.equal(startup.calls.start, 0);
  assert.throws(() => createRuntimeHost({ startup: {} }), /startup\.start is required/);
  assert.throws(() => createRuntimeHost({}), /startup\.start is required/);
});

test("ready only after startup completes, and concurrent or repeated starts share one attempt", async () => {
  let finish;
  const startup = fakeStartup(() => new Promise((resolve) => { finish = resolve; }));
  const host = createRuntimeHost({ startup, warn: quiet });
  const first = host.start();
  const second = host.start();
  assert.equal(first, second);
  assert.equal(host.status(), "starting");
  assert.equal(host.isReady(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.isReady(), false);
  finish();
  await first;
  assert.equal(host.isReady(), true);
  assert.equal(host.status(), "ready");
  assert.equal(host.start(), first);
  assert.equal(startup.calls.start, 1);
});

test("a failed startup is not ready, reports only a coarse failed state, and can be retried", async () => {
  const warnings = [];
  const secret = "sk-secret-credential";
  const startup = fakeStartup((attempt) => attempt === 1 ? Promise.reject(new TypeError(`provider said ${secret}`)) : Promise.resolve());
  const host = createRuntimeHost({ startup, warn: (...args) => warnings.push(args) });
  await assert.rejects(host.start(), /provider said/);
  assert.equal(host.isReady(), false);
  assert.equal(host.status(), "failed");
  assert.deepEqual(warnings, [["[backend] runtime startup failed", "TypeError"]]);
  assert.equal(JSON.stringify(warnings).includes(secret), false);
  await host.start();
  assert.equal(host.isReady(), true);
  assert.equal(startup.calls.start, 2);
});

test("a synchronous startup throw is handled like a rejection", async () => {
  const startup = fakeStartup(() => { throw new RangeError("sync failure"); });
  const host = createRuntimeHost({ startup, warn: quiet });
  await assert.rejects(host.start(), /sync failure/);
  assert.equal(host.status(), "failed");
});

test("stopping makes the host permanently not ready, cancels warmups and refuses to start again", async () => {
  const startup = fakeStartup();
  const host = createRuntimeHost({ startup, warn: quiet });
  await host.start();
  host.stop();
  assert.equal(host.isReady(), false);
  assert.equal(host.status(), "stopped");
  assert.equal(startup.calls.cancel, 1);
  await assert.rejects(host.start(), /stopped/);
  assert.equal(startup.calls.start, 1);
});

test("a stop during startup wins: completion must not flip the host to ready", async () => {
  let finish;
  const startup = fakeStartup(() => new Promise((resolve) => { finish = resolve; }));
  const host = createRuntimeHost({ startup, warn: quiet });
  const starting = host.start();
  // startup.start() runs on the next microtask; let it begin before stopping.
  await new Promise((resolve) => setImmediate(resolve));
  host.stop();
  finish();
  await starting;
  assert.equal(host.isReady(), false);
  assert.equal(host.status(), "stopped");
});

test("a failure after stop keeps the host stopped rather than failed", async () => {
  let fail;
  const startup = fakeStartup(() => new Promise((_resolve, reject) => { fail = reject; }));
  const host = createRuntimeHost({ startup, warn: quiet });
  const starting = host.start();
  await new Promise((resolve) => setImmediate(resolve));
  host.stop();
  fail(new Error("late failure"));
  await assert.rejects(starting, /late failure/);
  assert.equal(host.status(), "stopped");
});

test("stop works without warmup support and before any start", () => {
  const host = createRuntimeHost({ startup: { start: () => Promise.resolve() }, warn: quiet });
  host.stop();
  assert.equal(host.status(), "stopped");
  assert.equal(host.isReady(), false);
});

function startupSpy() {
  const calls = { start: 0, cancelWarmups: 0 };
  return {
    calls,
    startup: {
      start: async () => { calls.start += 1; },
      cancelWarmups: () => { calls.cancelWarmups += 1; },
    },
  };
}

test("a restart starts the runtime again and keeps the generation", async () => {
  const { startup, calls } = startupSpy();
  const host = createRuntimeHost({ startup });
  await host.start();
  host.setGeneration("gen-1");
  const result = await host.restart({ generation: "gen-1", reason: "operator" });
  assert.deepEqual(result, { ok: true, generation: "gen-1", restarts: 2, reason: "operator" });
  assert.equal(calls.start, 2);
  assert.equal(host.isReady(), true);
  assert.equal(host.generationInfo().generation, "gen-1");
});

test("a restart refuses to swap the running generation", async () => {
  const { startup, calls } = startupSpy();
  const host = createRuntimeHost({ startup });
  await host.start();
  host.setGeneration("gen-1");
  assert.deepEqual(await host.restart({ generation: "gen-2" }), { ok: false, reason: "generation-mismatch" });
  assert.equal(calls.start, 1, "the runtime must keep running");
  assert.equal(host.isReady(), true);
  // An explicit operator decision may change it.
  const changed = await host.restart({ generation: "gen-2", allowGenerationChange: true });
  assert.equal(changed.ok, true);
  assert.equal(host.generationInfo().generation, "gen-2");
});

test("the restart budget is bounded inside the window and recovers after it", async () => {
  const { startup, calls } = startupSpy();
  let clock = 1_000;
  const host = createRuntimeHost({ startup, now: () => clock, maxRestarts: 2, restartWindowMs: 1_000 });
  await host.start();
  assert.equal((await host.restart()).ok, true);
  assert.equal((await host.restart()).ok, false);
  assert.equal(calls.start, 2, "the third attempt is refused before starting");
  assert.equal(host.generationInfo().restartsInWindow, 2);
  clock += 1_001;
  assert.equal((await host.restart()).ok, true);
  assert.equal(calls.start, 3, "attempts outside the window do not count");
});

test("a restart of a stopped host is refused, and a failed startup is reported not thrown", async () => {
  const host = createRuntimeHost({ startup: { start: async () => { throw new Error("nope"); } } });
  assert.deepEqual(await host.restart(), { ok: false, reason: "startup-failed" });
  assert.equal(host.status(), "failed");
  await host.start().catch(() => {});
  host.stop();
  assert.deepEqual(await host.restart(), { ok: false, reason: "stopped" });
});

test("an invalid budget is rejected at construction", () => {
  for (const options of [{ maxRestarts: -1 }, { restartWindowMs: 0 }, { restartWindowMs: Number.NaN }]) {
    assert.throws(() => createRuntimeHost({ startup: { start: async () => {} }, ...options }), /must be/);
  }
});
