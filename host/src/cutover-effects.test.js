import assert from "node:assert/strict";
import { test } from "node:test";
import { runCutover } from "./cutover.js";
import { createCutoverEffects } from "./cutover-effects.js";

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
        stop: () => calls.push("backend.stop"),
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

test("the switches the Host must set are reported, and missing primitives are refused", () => {
  const effects = createCutoverEffects({ ...harness().options, backendOwnsRuntime: true, relayEnabled: true });
  assert.deepEqual(effects.switches, { backendOwnsRuntime: true, relayEnabled: true });
  assert.throws(() => createCutoverEffects({}), /stopWeb is required/);
  assert.throws(() => createCutoverEffects({ stopWeb: async () => {}, spawnWeb: async () => {}, preflight: async () => ({ ok: true }) }), /backendService is required/);
});
