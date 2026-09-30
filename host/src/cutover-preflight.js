import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync, readdirSync as defaultReaddirSync } from "node:fs";
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

/** The task rows in the app store, or none when it cannot be read. Read-only: never written here. */
export function readStoreTasks(storePath, { readFile = defaultReadFileSync, exists = defaultExistsSync } = {}) {
  if (!exists(storePath)) return [];
  try {
    const store = JSON.parse(readFile(storePath, "utf8"));
    return Array.isArray(store?.tasks) ? store.tasks : [];
  } catch {
    return [];
  }
}

/** Every task lease on disk, with its owner pid. An unreadable lease is unknown, not ignored. */
export function readLeases(leaseDir, { readdir = defaultReaddirSync, readFile = defaultReadFileSync, exists = defaultExistsSync } = {}) {
  if (!exists(leaseDir)) return [];
  let entries = [];
  try {
    entries = readdir(leaseDir).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
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
  countGoalLoops = async () => 0,
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
    const goalLoopSessions = await countGoalLoops().catch(() => 0);
    return cutoverPreflight({
      phase: CUTOVER_START_PHASE,
      backendConfigured: Boolean(token),
      // A detached Backend answers ok:true/ready:false, which the start phase accepts.
      health: healthResult?.ok === true ? { ok: true, ready: healthResult.ready === true } : { ok: false },
      expectedGeneration,
      activeTasks: readStoreTasks(store, readers),
      leases: readLeases(leasesDir, readers),
      ownPid,
      goalLoopSessions: Number(goalLoopSessions) || 0,
      otherOwner,
      // The pre-cutover state: this WebUI still owns the runtime and does not relay.
      relayEnabled: false,
      webOwnsRuntime: true,
    });
  };
}
