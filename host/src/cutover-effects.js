import { readBackendHealth } from "./backend-health.js";

/**
 * Binds the cutover stages to the Host's real primitives.
 *
 * The Host keeps the lifecycle: it stops and starts the WebUI, starts and stops the Backend child, and
 * reads the Backend's health itself. This module only translates those primitives into the effects
 * `runCutover` expects, so the sequence stays testable and the Host stays the only owner of processes.
 */
export function createCutoverEffects({
  stopWeb,
  spawnWeb,
  backendService,
  baseUrl,
  token,
  expectedGeneration = "",
  backendOwnsRuntime,
  relayEnabled,
  preflight,
  fetchImpl,
  timeoutMs,
} = {}) {
  for (const [name, fn] of Object.entries({ stopWeb, spawnWeb, backendService, preflight })) {
    if (typeof fn !== "function" && name !== "backendService") throw new Error(`${name} is required`);
    if (name === "backendService" && !fn) throw new Error("backendService is required");
  }
  const read = () =>
    readBackendHealth({
      baseUrl,
      token,
      expectedGeneration,
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  return {
    preflight,
    stopWebUi: () => stopWeb(),
    /** Ownership travels with the WebUI process: the switches are part of its environment. */
    startWebUi: ({ ownsRuntime, relay }) =>
      spawnWeb({ ownership: ownsRuntime ? "in-process" : "backend", relay: Boolean(relay) }),
    stopBackend: async () => backendService.stop(),
    startBackendAttached: async () => {
      backendService.start({ attachRuntime: true });
    },
    /** One check; `runCutover` owns the polling and the deadline. */
    waitReady: async () => {
      const health = await read();
      return health.ok === true && health.ready === true;
    },
    /** The switches the Host must set on the WebUI process for the hand-over to be consistent. */
    switches: { backendOwnsRuntime: Boolean(backendOwnsRuntime), relayEnabled: Boolean(relayEnabled) },
  };
}

/**
 * Confirms the hand-over from the outside: the WebUI must report a satisfied cutover (it is serving the
 * Backend and no longer owns the runtime) and the Backend must still be ready at the pinned generation.
 *
 * A status that cannot be read is a failure, not a pass: an unverified cutover is rolled back.
 */
export function createCutoverVerify({ readHealth, readWebUiCutover, expectedGeneration = "" } = {}) {
  if (typeof readHealth !== "function") throw new Error("readHealth is required");
  if (typeof readWebUiCutover !== "function") throw new Error("readWebUiCutover is required");
  return async function verify() {
    const blockers = [];
    const health = await readHealth();
    if (health?.ok !== true) blockers.push({ code: "backend-unreachable" });
    else if (health.ready !== true) blockers.push({ code: "backend-not-ready" });
    else if (expectedGeneration && health.generation?.running !== expectedGeneration) {
      blockers.push({ code: "generation-mismatch", detail: expectedGeneration });
    }
    let status = null;
    try {
      status = await readWebUiCutover();
    } catch {
      status = null;
    }
    if (!status) blockers.push({ code: "webui-unreachable" });
    else if (status.cutover?.ok !== true) {
      const reported = Array.isArray(status.cutover?.blockers) ? status.cutover.blockers : [];
      blockers.push(...(reported.length > 0 ? reported.map((code) => ({ code })) : [{ code: "webui-cutover-not-ok" }]));
    }
    return { ok: blockers.length === 0, blockers };
  };
}
