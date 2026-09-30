import { readFileSync as defaultReadFileSync, readdirSync as defaultReaddirSync } from "node:fs";
import { join } from "node:path";
import { cutoverPreflight } from "../../backend/core/cutover-plan.mjs";

/**
 * The Host's own preflight inputs for the cutover.
 *
 * The Host is the only process that sees everything before the hand-over: the app store on disk, the
 * task lease files, the Goal Loop count the WebUI reports, and the Backend's health. It reads them
 * read-only and asks the shared core rule whether the hand-over may begin.
 *
 * The phase is "start": the Backend is still detached at this point, so readiness and the runtime
 * generation are checked by the attach stage, not here.
 */
export const CUTOVER_START_PHASE = "start";

const KNOWN_TASK_STATUSES = new Set(["working", "starting", "ready", "idle", "error", "archived"]);
const isKnownCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Missing is empty; unreadable, malformed or unknown task state is null. Never writes. */
export function readStoreTasks(storePath, { readFile = defaultReadFileSync } = {}) {
  try {
    const store = JSON.parse(readFile(storePath, "utf8"));
    return Array.isArray(store?.tasks) && store.tasks.every((task) =>
      typeof task?.id === "string" && task.id.length > 0 && KNOWN_TASK_STATUSES.has(task?.status)
    ) ? store.tasks : null;
  } catch (error) {
    return error?.code === "ENOENT" ? [] : null;
  }
}

/** Unreadable listing is null; an unreadable individual lease remains a foreign/unknown owner. */
export function readLeases(leaseDir, { readdir = defaultReaddirSync, readFile = defaultReadFileSync } = {}) {
  let entries = [];
  try {
    entries = readdir(leaseDir).filter((entry) => entry.endsWith(".json"));
  } catch (error) {
    return error?.code === "ENOENT" ? [] : null;
  }
  const leases = [];
  for (const entry of entries) {
    const taskId = entry.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(readFile(join(leaseDir, entry), "utf8"));
      leases.push({ taskId, pid: typeof parsed?.pid === "number" ? parsed.pid : null });
    } catch {
      leases.push({ taskId, pid: null });
    }
  }
  return leases;
}

/** An unavailable or invalid WebUI observation is unknown, never zero. */
export async function readActiveGoalLoopCount({ baseUrl, token, fetchImpl = fetch, timeoutMs = 3_000 } = {}) {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/goal-loop/active`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) return null;
    const body = await response.json();
    return isKnownCount(body?.active) ? body.active : null;
  } catch {
    return null;
  }
}

/**
 * Builds the preflight the Host hands to `runCutover`.
 *
 * `readHealth` and `countGoalLoops` are injected because only the Host knows how to reach the Backend
 * and the WebUI; the disk readers default to the real data directory layout.
 */
export function createCutoverPreflight({
  dataDir,
  token,
  expectedGeneration = "",
  ownPid = process.pid,
  readHealth,
  countGoalLoops = async () => null,
  otherOwner = false,
  storePath,
  leaseDir,
  readers = {},
} = {}) {
  if (!dataDir) throw new Error("dataDir is required");
  if (typeof readHealth !== "function") throw new Error("readHealth is required");
  if (typeof countGoalLoops !== "function") throw new Error("countGoalLoops is required");
  const store = storePath ?? join(dataDir, "store.json");
  const leasesDir = leaseDir ?? join(dataDir, "task-leases");
  return async function preflight() {
    const healthResult = await readHealth();
    let goalLoopSessions = null;
    try {
      const observed = await countGoalLoops();
      if (isKnownCount(observed)) goalLoopSessions = observed;
    } catch {
      // Unknown work cannot justify stopping the runtime owner.
    }
    const tasks = readStoreTasks(store, readers);
    const leases = readLeases(leasesDir, readers);
    const result = cutoverPreflight({
      phase: CUTOVER_START_PHASE,
      backendConfigured: Boolean(token),
      // A detached Backend answers ok:true/ready:false, which the start phase accepts.
      health: healthResult?.ok === true ? { ok: true, ready: healthResult.ready === true } : { ok: false },
      expectedGeneration,
      activeTasks: tasks ?? [],
      leases: leases ?? [],
      ownPid,
      goalLoopSessions: goalLoopSessions ?? 0,
      otherOwner,
      // The pre-cutover state: this WebUI still owns the runtime and does not relay.
      relayEnabled: false,
      webOwnsRuntime: true,
    });
    if (tasks === null) result.blockers.push({ code: "store-state-unknown" });
    if (leases === null) result.blockers.push({ code: "lease-state-unknown" });
    if (goalLoopSessions === null) result.blockers.push({ code: "goal-loop-state-unknown" });
    return {
      ...result,
      ok: result.blockers.length === 0,
      activeTasks: tasks === null ? null : result.activeTasks,
      foreignLeases: leases === null ? null : result.foreignLeases,
      goalLoopSessions,
    };
  };
}
