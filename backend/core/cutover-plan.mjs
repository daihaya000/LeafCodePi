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
  const blockers = [];
  const active = (activeTasks ?? []).filter((task) => ACTIVE_TASK_STATUSES.has(task?.status)).length;
  const foreign = (leases ?? []).filter((lease) => isForeignLease(lease, ownPid)).length;

  if (!backendConfigured) blockers.push({ code: "backend-not-configured" });
  if (!health || health.ok !== true) blockers.push({ code: "backend-unreachable" });
  else if (health.ready !== true) blockers.push({ code: "backend-not-ready" });
  if (health?.ok === true && health.ready === true && !health.runtimeGeneration) {
    // A ready Backend without a runtime cannot take the sessions over; there is nothing to hand to.
    blockers.push({ code: "runtime-detached" });
  }
  if (health?.ok === true) {
    const wanted = typeof expectedGeneration === "string" ? expectedGeneration.trim() : "";
    const running = health.runtimeGeneration ?? null;
    if (wanted && running !== wanted) blockers.push({ code: "generation-mismatch", detail: wanted });
  }
  if (otherOwner) blockers.push({ code: "another-owner" });
  if (active > 0) blockers.push({ code: "active-work", detail: active });
  if (goalLoopSessions > 0) blockers.push({ code: "goal-loop-active", detail: goalLoopSessions });
  if (foreign > 0) blockers.push({ code: "foreign-lease", detail: foreign });
  // The two processes must agree on who owns the runtime. Relaying reads while this process still
  // owns it, or handing it over while the WebUI still serves its own view, are both half-done states.
  if (relayEnabled && webOwnsRuntime) blockers.push({ code: "mixed-ownership" });
  if (!relayEnabled && !webOwnsRuntime) blockers.push({ code: "relay-disabled" });

  return { ok: blockers.length === 0, blockers, activeTasks: active, goalLoopSessions, foreignLeases: foreign };
}
