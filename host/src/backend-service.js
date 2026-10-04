import { randomBytes } from "node:crypto";
import { BACKEND_CHILD_PROCESS_MESSAGE } from "../../shared/backend-child-process-message.mjs";
import { processStartKey } from "../../shared/process-identity.mjs";
import { backendClientEnv, backendLaunchPlan } from "./backend-launch.js";
import { hardKillTree, isProcessAlive } from "./process-stop.js";

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
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/** Whether the operator asked the Host to run a Backend process. */
export function isBackendRequested(env = {}) {
  return REQUESTED_VALUES.has((env.LEAFCODE_PI_BACKEND ?? "").trim().toLowerCase());
}

/**
 * Whether the Host runs the Backend process.
 *
 * The shipped architecture owns the runtime there, so production always runs one: a WebUI started
 * without a Backend would be a client of nothing. An explicit `LEAFCODE_PI_BACKEND=0` (tests,
 * headless probes) and an explicit development mode (where `next dev` owns the runtime itself) turn
 * it off.
 */
export function shouldRunBackend(env = {}) {
  const value = (env.LEAFCODE_PI_BACKEND ?? "").trim().toLowerCase();
  if (DISABLED_VALUES.has(value)) return false;
  if (value === "dev") return false;
  return (env.LEAFCODE_PI_MODE ?? "").trim().toLowerCase() !== "dev";
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
  getProcessStartKey = processStartKey,
  processAlive = isProcessAlive,
  killProcessTree = hardKillTree,
} = {}) {
  if (typeof spawn !== "function") throw new Error("spawn is required");
  // The plan is rebuilt for every launch so a cutover can ask for the runtime without re-creating
  // the service; the token, bundle and pinned generation stay the same.
  const buildPlan = (attach) => backendLaunchPlan({ repoRoot, env, token, attachRuntime: attach, bundlePath, generation });
  let plan = buildPlan(attachRuntime);
  let child = null;
  let state = "idle";
  let restarts = 0;
  let stopping = false;
  let stableTimer = null;
  let stopPromise = null;
  const backendChildProcesses = new Map();
  const exitCleanupByChild = new WeakMap();

  function clearStableTimer() {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
  }

  function handleBackendChildMessage(message) {
    if (!message || typeof message !== "object" || message.type !== BACKEND_CHILD_PROCESS_MESSAGE
      || typeof message.token !== "string" || !message.token) return;
    if (message.action === "stopped") {
      const child = backendChildProcesses.get(message.token);
      if (child && !backendChildTreeAlive(child.pid)) backendChildProcesses.delete(message.token);
      return;
    }
    if (!Number.isSafeInteger(message.pid) || message.pid <= 1) return;
    if (message.action === "identity") {
      const child = backendChildProcesses.get(message.token);
      if (child?.pid === message.pid) {
        child.processStartKey = typeof message.processKey === "string" && message.processKey ? message.processKey : null;
      }
      return;
    }
    if (message.action !== "started") return;
    backendChildProcesses.set(message.token, {
      pid: message.pid,
      processStartKey: typeof message.processKey === "string" && message.processKey ? message.processKey : null,
    });
  }

  function backendChildTreeAlive(pid) {
    // The MCP SDK launches detached process groups off Windows. Check the group as well as
    // its leader so a fast-exiting parent cannot make a surviving grandchild look reaped.
    return process.platform === "win32"
      ? processAlive(pid)
      : processAlive(-pid) || processAlive(pid);
  }

  async function killOwnedBackendChild({ pid, processStartKey }) {
    if (!backendChildTreeAlive(pid)) return true;
    if (!processStartKey) return false;

    try {
      killProcessTree(pid, {
        expectedProcessStartKey: processStartKey,
        getProcessStartKey,
        platform: process.platform,
      });
    } catch { /* Re-check below before deciding whether a restart is safe. */ }

    const deadline = Date.now() + 1_500;
    while (backendChildTreeAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !backendChildTreeAlive(pid);
  }

  function reapBackendChildren() {
    const pending = [...backendChildProcesses.entries()];
    if (pending.length === 0) return true;
    return Promise.all(pending.map(async ([token, child]) => {
      let reaped = false;
      try { reaped = await killOwnedBackendChild(child); } catch { reaped = false; }
      if (reaped) backendChildProcesses.delete(token);
      else error(`Backend child process cleanup could not be confirmed (pid ${child.pid}); restart blocked`);
      return reaped;
    })).then((results) => results.every(Boolean));
  }

  function finishExit(started, code, signal, cleanupSucceeded) {
    if (stopping) {
      // A cutover may relaunch only after child cleanup; shutdown remains terminal.
      state = state === "stopping" ? (cleanupSucceeded ? "idle" : "failed") : state;
      if (!cleanupSucceeded && state !== "stopped") {
        error(`Backend exited (${signal ?? code}) but child process cleanup could not be confirmed`);
      }
      return;
    }
    if (!cleanupSucceeded) {
      state = "failed";
      error(`Backend exited (${signal ?? code}) but child process cleanup could not be confirmed; restart blocked`);
      return;
    }
    restarts += 1;
    if (restarts > restartMax) {
      state = "failed";
      error(`Backend exited (${signal ?? code}) and its restart budget is spent`);
      return;
    }
    launch(`exit ${signal ?? code}`);
  }

  function launch(reason) {
    stopping = false;
    state = "starting";
    log(`Starting Backend (${plan.runtime} runtime, generation ${plan.generation ?? "unknown"})${reason ? ` after ${reason}` : ""}`);
    const started = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: { ...env, ...plan.env },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    child = started;
    started.on?.("message", handleBackendChildMessage);
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
      started.removeListener?.("message", handleBackendChildMessage);
      if (!stopping) state = "stopping";
      const cleanup = reapBackendChildren();
      exitCleanupByChild.set(started, cleanup);
      if (cleanup === true || cleanup === false) {
        finishExit(started, code, signal, cleanup);
      } else {
        void cleanup.then(
          (succeeded) => finishExit(started, code, signal, succeeded),
          () => finishExit(started, code, signal, false),
        );
      }
    });
    return started;
  }

  /** Cutover stop: retain the child until exit is observed, never treat kill() as termination. */
  async function stopForRestart({ timeoutMs = 5_000 } = {}) {
    if (state === "stopped") throw new Error("Backend service is stopped");
    if (stopPromise) return stopPromise;
    const running = child;
    if (!running) return;
    stopping = true;
    state = "stopping";
    clearStableTimer();
    stopPromise = new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        running.removeListener("exit", exited);
      };
      const exited = () => {
        cleanup();
        const childCleanup = exitCleanupByChild.get(running);
        if (childCleanup === false) {
          reject(new Error("Backend child process cleanup could not be confirmed"));
        } else if (childCleanup && typeof childCleanup.then === "function") {
          void childCleanup.then(
            (succeeded) => succeeded ? resolve() : reject(new Error("Backend child process cleanup could not be confirmed")),
            () => reject(new Error("Backend child process cleanup could not be confirmed")),
          );
        } else {
          resolve();
        }
      };
      const failed = (error) => {
        cleanup();
        // Still stopping: no new owner may start until the old child actually exits.
        reject(error);
      };
      running.once("exit", exited);
      timer = setTimeout(() => failed(new Error("Backend stop timed out")), timeoutMs);
      try {
        if (running.kill() === false) failed(new Error("Backend stop was refused"));
      } catch (error) {
        failed(error);
      }
    });
    try {
      await stopPromise;
    } finally {
      stopPromise = null;
    }
  }

  return {
    /**
     * Idempotent: a running Backend is not started twice, and a failed one is not retried here.
     * `attachRuntime` is an explicit request for the SDK-owning runtime (the Host's normal start
     * and its Backend restart both pass it); it is never implicit.
     */
    start({ attachRuntime: attach = attachRuntime } = {}) {
      if (state === "running" || state === "starting") return null;
      if (state === "stopped") throw new Error("Backend service is stopped");
      if (state === "stopping" || stopPromise) throw new Error("Backend service is stopping");
      if (state === "failed") {
        // The budget is spent: retrying is the Host's decision, not an implicit loop.
        error("Backend service failed and will not be started again");
        return null;
      }
      plan = buildPlan(Boolean(attach));
      return launch(null);
    },
    stopForRestart,
    stop() {
      stopping = true;
      clearStableTimer();
      const running = child;
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
