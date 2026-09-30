import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createBackendService } from "./backend-service.js";
import { runCutover } from "./cutover.js";
import { createCutoverEffects, createCutoverVerify } from "./cutover-effects.js";

const BASE = "http://127.0.0.1:18776";

// The default health is the attached Backend of the pinned generation.
function harness({ health = { ok: true, ready: true, runtimeGeneration: "gen-a" } } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      stopWeb: async () => calls.push("stopWeb"),
      spawnWeb: async (state) => calls.push(`spawnWeb:${state.ownership}:relay=${state.relay ? "on" : "off"}`),
      backendService: {
        start: (options) => calls.push(`backend.start:attach=${Boolean(options?.attachRuntime)}`),
        stopForRestart: () => calls.push("backend.stop"),
      },
      baseUrl: BASE,
      token: "t".repeat(40),
      expectedGeneration: "gen-a",
      preflight: async () => {
        calls.push("preflight");
        return { ok: true, blockers: [] };
      },
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => health }),
    },
  };
}

test("the effects translate the stages into Host calls", async () => {
  const { calls, options } = harness();
  const effects = createCutoverEffects(options);
  const result = await runCutover({ ...effects, sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "preflight",
    "stopWeb", // the old owner stops first
    "backend.stop", // the detached Backend is replaced by an attached one
    "backend.start:attach=true",
    "spawnWeb:backend:relay=on", // the WebUI returns as a client of the Backend
  ]);
});

test("cutover waits for the old child's exit before attaching on the same real service", async (t) => {
  const children = [];
  const launches = [];
  const service = createBackendService({
    repoRoot: "C:/repo", token: "t".repeat(40), generation: "gen-a",
    spawn: (_command, _args, options) => {
      const child = new EventEmitter();
      child.kill = () => true; // Requested, not yet exited.
      children.push(child);
      launches.push(options.env);
      return child;
    },
  });
  t.after(() => {
    service.stop();
    for (const child of children) child.emit("exit", 0, null);
  });
  service.start();
  const effects = createCutoverEffects({ ...harness().options, backendService: service });
  const pending = runCutover(effects);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.status().state, "stopping");
  assert.equal(launches.length, 1, "kill() did not yet confirm the detached child stopped");
  children[0].emit("exit", 0, null);
  assert.equal((await pending).ok, true);
  assert.equal(launches.length, 2);
  assert.equal(launches[0].LEAFCODE_PI_BACKEND_RUNTIME, "");
  assert.equal(launches[1].LEAFCODE_PI_BACKEND_RUNTIME, "attach");
  assert.equal(launches[1].LEAFCODE_PI_BACKEND_TOKEN, launches[0].LEAFCODE_PI_BACKEND_TOKEN);
  assert.equal(service.status().generation, "gen-a");
  assert.equal(service.status().runtime, "attach");
});

test("waitReady reads the Backend itself, and is false for a not-ready or mismatched Backend", async () => {
  const cases = [
    [{ ok: true, ready: false }, false],
    [{ ok: true, ready: true, runtimeGeneration: "gen-b" }, false],
    [{ ok: true, ready: true, runtimeGeneration: "gen-a" }, true],
    [{ ok: true, ready: true, runtimeGeneration: null }, false, { expectedGeneration: "gen-a" }],
  ];
  for (const [health, expected, override] of cases) {
    const { options } = harness({ health });
    const effects = createCutoverEffects({ ...options, ...(override ?? {}) });
    assert.equal(await effects.waitReady(), expected, JSON.stringify(health));
  }
  const unreachable = createCutoverEffects({
    ...harness().options,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(await unreachable.waitReady(), false);
});

test("a rollback restarts the WebUI owning the runtime and relay off", async () => {
  const { calls, options } = harness({ health: { ok: true, ready: false } });
  const effects = createCutoverEffects(options);
  let clock = 0;
  const result = await runCutover({
    ...effects,
    now: () => clock,
    sleep: async () => { clock += 1_000; },
    readyTimeoutMs: 1_000,
  });
  assert.equal(result.stage, "attach-backend");
  assert.equal(result.rolledBack, true);
  assert.deepEqual(calls.slice(-2), ["backend.stop", "spawnWeb:in-process:relay=off"]);
});

test("verification needs both the Backend and the WebUI to agree", async () => {
  const ready = async () => ({ ok: true, ready: true, generation: { pinned: "gen-a", running: "gen-a", matches: true } });
  const satisfied = async () => ({ cutover: { ok: true, blockers: [] } });
  const cases = [
    [ready, satisfied, true, []],
    [async () => ({ ok: true, ready: false }), satisfied, false, [{ code: "backend-not-ready" }]],
    [async () => ({ ok: false, reason: "unreachable" }), satisfied, false, [{ code: "backend-unreachable" }]],
    [ready, async () => ({ cutover: { ok: false, blockers: ["relay-disabled"] } }), false, [{ code: "relay-disabled" }]],
    [ready, async () => ({ cutover: { ok: false } }), false, [{ code: "webui-cutover-not-ok" }]],
    [ready, async () => { throw new Error("ECONNREFUSED"); }, false, [{ code: "webui-unreachable" }]],
    [
      async () => ({ ok: true, ready: true, generation: { pinned: "gen-a", running: "gen-b", matches: false } }),
      satisfied,
      false,
      [{ code: "generation-mismatch", detail: "gen-a" }],
    ],
  ];
  for (const [readHealth, readWebUiCutover, expected, blockers] of cases) {
    const verify = createCutoverVerify({ readHealth, readWebUiCutover, expectedGeneration: "gen-a" });
    const result = await verify();
    assert.equal(result.ok, expected);
    assert.deepEqual(result.blockers, blockers);
  }
  // Without a pinned generation there is nothing to compare.
  const unpinned = createCutoverVerify({
    readHealth: async () => ({ ok: true, ready: true, generation: { pinned: null, running: "gen-z", matches: true } }),
    readWebUiCutover: satisfied,
  });
  assert.equal((await unpinned()).ok, true);
});

test("the switches the Host must set are reported, and missing primitives are refused", () => {
  const effects = createCutoverEffects({ ...harness().options, backendOwnsRuntime: true, relayEnabled: true });
  assert.deepEqual(effects.switches, { backendOwnsRuntime: true, relayEnabled: true });
  assert.throws(() => createCutoverEffects({}), /stopWeb is required/);
  assert.throws(() => createCutoverEffects({ stopWeb: async () => {}, spawnWeb: async () => {}, preflight: async () => ({ ok: true }) }), /backendService is required/);
  assert.throws(() => createCutoverVerify({}), /readHealth is required/);
  assert.throws(() => createCutoverVerify({ readHealth: async () => ({}) }), /readWebUiCutover is required/);
});
