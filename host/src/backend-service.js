import { randomBytes } from "node:crypto";
import { backendClientEnv, backendLaunchPlan } from "./backend-launch.js";

/**
 * The Host's lifecycle for the independent Backend process.
 *
 * Off by default: the Web process still owns the SDK and the store, so starting a second process
 * only happens when an operator asks for it. The service never attaches the runtime unless it is
 * told to, because two owners would double-write the store, leases and sessions.
 *
 * The restart budget is the Backend's own, separate from the WebUI's: a crashing Backend does not
 * spend the WebUI's budget, and the count resets once the process stayed up for a full window.
 */
export const BACKEND_RESTART_BUDGET_RESET_MS = 60_000;

const REQUESTED_VALUES = new Set(["1", "true", "yes", "attach"]);

/** Whether the operator asked the Host to run a Backend process. */
export function isBackendRequested(env = {}) {
  return REQUESTED_VALUES.has((env.LEAFCODE_PI_BACKEND ?? "").trim().toLowerCase());
}

export function createBackendService({
  repoRoot,
  env = {},
  token = randomBytes(32).toString("base64url"),
  spawn,
  log = () => {},
  error = () => {},
  now = () => Date.now(),
  restartMax = 3,
  attachRuntime = false,
  bundlePath,
  generation,
  budgetResetMs = BACKEND_RESTART_BUDGET_RESET_MS,
} = {}) {
  if (typeof spawn !== "function") throw new Error("spawn is required");
  const plan = backendLaunchPlan({ repoRoot, env, token, attachRuntime, bundlePath, generation });
  let child = null;
  let state = "idle";
  let restarts = 0;
  let stopping = false;
  let stableTimer = null;

  function clearStableTimer() {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
  }

  function launch(reason) {
    stopping = false;
    state = "starting";
    log(`Starting Backend (${plan.runtime} runtime, generation ${plan.generation ?? "unknown"})${reason ? ` after ${reason}` : ""}`);
    const started = spawn(plan.command, plan.args, { cwd: plan.cwd, env: { ...env, ...plan.env }, stdio: "pipe", windowsHide: true });
    child = started;
    state = "running";
    clearStableTimer();
    // A process that stayed up for a full window has earned its budget back.
    stableTimer = setTimeout(() => {
      if (child === started) restarts = 0;
    }, budgetResetMs);
    stableTimer.unref?.();
    started.once?.("exit", (code, signal) => {
      if (child !== started) return;
      child = null;
      clearStableTimer();
      if (stopping) {
        state = "stopped";
        return;
      }
      restarts += 1;
      if (restarts > restartMax) {
        state = "failed";
        error(`Backend exited (${signal ?? code}) and its restart budget is spent`);
        return;
      }
      launch(`exit ${signal ?? code}`);
    });
    return started;
  }

  return {
    /** Idempotent: a running Backend is not started twice, and a failed one is not retried here. */
    start() {
      if (state === "running" || state === "starting") return null;
      if (state === "stopped") throw new Error("Backend service is stopped");
      if (state === "failed") {
        // The budget is spent: retrying is the Host's decision, not an implicit loop.
        error("Backend service failed and will not be started again");
        return null;
      }
      return launch(null);
    },
    stop() {
      stopping = true;
      clearStableTimer();
      const running = child;
      child = null;
      state = "stopped";
      running?.kill?.();
    },
    /** The environment the WebUI child needs to reach this Backend, or null when it is not used. */
    clientEnv: () => backendClientEnv(plan),
    status: () => ({ state, generation: plan.generation, runtime: plan.runtime, restarts }),
    /** The plan this service would spawn; exposed so the Host can log what it decided. */
    plan,
  };
}
