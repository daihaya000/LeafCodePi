/**
 * Preflight for the exclusive cutover: may this process stop owning the Pi runtime and let the
 * Backend own it?
 *
 * The cutover is exclusive by design. While two owners exist, both write the same store, leases and
 * session files, so every reason to refuse is listed rather than guessed at. This module is pure:
 * the caller injects the health it read, the tasks it sees and the leases it holds, and gets back a
 * decision plus machine-readable blockers for logs and the UI.
 *
 * Blocker codes are stable; the wording of a message is the caller's business.
 */

/**
 * Which question is being asked:
 * - "start": may the hand-over begin? The Backend may still be detached — it is attached during the
 *   cutover — but nothing may be running that would be lost, and no other owner may exist.
 * - "verify": is the cutover satisfied? Then readiness, the pinned generation and the ownership
 *   switches are what matters.
 */
export const CUTOVER_PHASES = ["start", "verify"];

/** Task statuses that mean work is running in this process right now. */
const ACTIVE_TASK_STATUSES = new Set(["working", "starting"]);

/**
 * A lease this process does not own. A record without an owner pid is unknown, not ours: the real
 * lease files always carry a numeric pid, so an unidentified one is treated as a foreign owner
 * rather than assumed to be safe.
 */
function isForeignLease(lease, ownPid) {
  if (!lease) return false;
  if (lease.pid === undefined || lease.pid === null) return true;
  if (ownPid === undefined || ownPid === null) return true;
  return String(lease.pid) !== String(ownPid);
}

/**
 * @returns {{ ok: boolean, blockers: Array<{ code: string, detail?: string | number }>,
 *   activeTasks: number, goalLoopSessions: number, foreignLeases: number }}
 */
export function cutoverPreflight({
  phase = "verify",
  backendConfigured = false,
  health = null,
  expectedGeneration = "",
  activeTasks = [],
  goalLoopSessions = 0,
  leases = [],
  ownPid = null,
  otherOwner = false,
  relayEnabled = false,
  webOwnsRuntime = true,
} = {}) {
  if (!CUTOVER_PHASES.includes(phase)) throw new Error(`unknown cutover phase: ${phase}`);
  const blockers = [];
  const active = (activeTasks ?? []).filter((task) => ACTIVE_TASK_STATUSES.has(task?.status)).length;
  const foreign = (leases ?? []).filter((lease) => isForeignLease(lease, ownPid)).length;

  if (!backendConfigured) blockers.push({ code: "backend-not-configured" });
  if (!health || health.ok !== true) blockers.push({ code: "backend-unreachable" });
  if (health?.ok === true) {
    const wanted = typeof expectedGeneration === "string" ? expectedGeneration.trim() : "";
    const running = health.runtimeGeneration ?? null;
    if (phase === "verify") {
      if (health.ready !== true) blockers.push({ code: "backend-not-ready" });
      else if (!running) blockers.push({ code: "runtime-detached" });
      if (wanted && running !== wanted) blockers.push({ code: "generation-mismatch", detail: wanted });
    }
  }
  if (otherOwner) blockers.push({ code: "another-owner" });
  if (active > 0) blockers.push({ code: "active-work", detail: active });
  if (goalLoopSessions > 0) blockers.push({ code: "goal-loop-active", detail: goalLoopSessions });
  if (foreign > 0) blockers.push({ code: "foreign-lease", detail: foreign });
  if (phase === "verify") {
    // The two processes must agree on who owns the runtime. Relaying reads while this process still
    // owns it, or handing it over while the WebUI still serves its own view, are both half-done.
    if (relayEnabled && webOwnsRuntime) blockers.push({ code: "mixed-ownership" });
    if (!relayEnabled && !webOwnsRuntime) blockers.push({ code: "relay-disabled" });
  } else if (relayEnabled && webOwnsRuntime) {
    // Starting the hand-over from the intended pre-cutover state is fine; it is only inconsistent
    // once the cutover claims to be done.
    blockers.push({ code: "relay-disabled" });
  }

  return { phase, ok: blockers.length === 0, blockers, activeTasks: active, goalLoopSessions, foreignLeases: foreign };
}
