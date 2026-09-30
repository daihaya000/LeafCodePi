import assert from "node:assert/strict";
import { test } from "node:test";
import { CUTOVER_STAGES, runCutover } from "./cutover.js";

/** Records the order of every effect, and lets a test make one of them fail. */
function harness({ failAt = null, ready = true } = {}) {
  const calls = [];
  const errors = [];
  const record = (name) => async (...args) => {
    calls.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
    if (name === "waitReady") return ready;
    return undefined;
  };
  return {
    calls,
    errors,
    options: {
      preflight: async () => {
        calls.push("preflight");
        return { ok: true, blockers: [] };
      },
      stopWebUi: record("stopWebUi"),
      startWebUi: async (state) => {
        calls.push(`startWebUi:${state.ownsRuntime ? "owns" : "client"}:relay=${state.relay ? "on" : "off"}`);
        if (failAt === "startWebUi" && !state.ownsRuntime) throw new Error("startWebUi failed");
      },
      stopBackend: record("stopBackend"),
      startBackendAttached: record("startBackendAttached"),
      waitReady: record("waitReady"),
      log: () => {},
      error: (message) => errors.push(message),
      sleep: async () => {},
    },
  };
}

test("the stages are ordered, and the runtime never has two owners", () => {
  assert.deepEqual(CUTOVER_STAGES, ["check", "stop-old-path", "attach-backend", "hand-over", "done"]);
});

test("a satisfied cutover stops the old path, attaches, then hands over", async () => {
  const { calls, options } = harness();
  const result = await runCutover(options);
  assert.deepEqual(result, { ok: true, stage: "done", rolledBack: false, stages: CUTOVER_STAGES });
  assert.deepEqual(calls, [
    "preflight",
    "stopWebUi", // the old owner stops before anything attaches
    "stopBackend",
    "startBackendAttached",
    "waitReady",
    "startWebUi:client:relay=on", // the WebUI returns as a client of the Backend
  ]);
});

test("a refused preflight changes nothing at all", async () => {
  const { calls, options } = harness();
  options.preflight = async () => ({ ok: false, blockers: [{ code: "active-work", detail: 1 }, { code: "goal-loop-active" }] });
  const result = await runCutover(options);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "check");
  assert.equal(result.rolledBack, false);
  assert.deepEqual(result.blockers, [{ code: "active-work", detail: 1 }, { code: "goal-loop-active" }]);
  assert.deepEqual(calls, [], "no effect ran");
});

test("a failed attach rolls back to the WebUI owning the runtime", async () => {
  const { calls, options, errors } = harness({ ready: false });
  let clock = 0;
  options.now = () => clock;
  options.sleep = async () => { clock += 1_000; };
  options.readyTimeoutMs = 3_000;
  const result = await runCutover(options);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "attach-backend");
  assert.equal(result.reason, "not-ready");
  assert.equal(result.rolledBack, true);
  assert.deepEqual(calls, [
    "preflight",
    "stopWebUi",
    "stopBackend",
    "startBackendAttached",
    "waitReady",
    "waitReady",
    "waitReady",
    "stopBackend",
    "startWebUi:owns:relay=off",
  ]);
  assert.deepEqual(errors, [], "a rollback is expected, not an error");
});

test("a failed hand-over rolls back too, and the WebUI gets its runtime back", async () => {
  const { calls, options } = harness({ failAt: "startWebUi" });
  const result = await runCutover(options);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "hand-over");
  assert.equal(result.reason, "start-failed");
  assert.equal(result.rolledBack, true);
  assert.deepEqual(calls.slice(-3), ["startWebUi:client:relay=on", "stopBackend", "startWebUi:owns:relay=off"]);
});

test("a WebUI that cannot stop is not rolled back over: nothing changed yet", async () => {
  const { calls, options } = harness({ failAt: "stopWebUi" });
  const result = await runCutover(options);
  assert.equal(result.stage, "stop-old-path");
  assert.equal(result.rolledBack, false);
  assert.deepEqual(calls, ["preflight", "stopWebUi"]);
});

test("rollback failures are reported, not thrown", async () => {
  const errors = [];
  let stopCalls = 0;
  const result = await runCutover({
    preflight: async () => ({ ok: true, blockers: [] }),
    stopWebUi: async () => {},
    // The hand-over fails, and so does the rollback that follows it.
    startWebUi: async () => { throw new Error("spawn failed"); },
    stopBackend: async () => {
      stopCalls += 1;
      if (stopCalls > 1) throw new Error("kill failed");
    },
    startBackendAttached: async () => {},
    waitReady: async () => true,
    error: (message) => errors.push(message),
    sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "hand-over");
  assert.equal(result.rolledBack, true);
  assert.deepEqual(errors, [
    // The hand-over failure itself, then both rollback steps.
    "Cutover could not restart the WebUI: spawn failed",
    "Rollback could not stop the Backend: kill failed",
    "Rollback could not restart the WebUI: spawn failed",
  ]);
});

test("missing effects are refused before anything runs", async () => {
  await assert.rejects(() => runCutover({}), /preflight is required/);
  await assert.rejects(() => runCutover({ preflight: async () => ({ ok: true }) }), /stopWebUi is required/);
});
