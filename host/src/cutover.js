/**
 * The exclusive cutover, as a staged transition with a rollback.
 *
 * Ownership of the Pi runtime must never be shared, so the order matters: the old path stops before
 * the Backend attaches, and the WebUI only comes back once the Backend is ready and owns the runtime.
 * The WebUI is briefly down during the hand-over; the Backend is not, which is the whole point of the
 * separation (sessions and schedules survive a WebUI restart).
 *
 * Every effect is injected, so the sequence can be tested without touching a live process. A failed
 * stage rolls back to the pre-cutover state: Backend stopped, WebUI running and owning the runtime.
 */

/** The stages, in order. The last stage is the only success state. */
export const CUTOVER_STAGES = ["check", "stop-old-path", "attach-backend", "hand-over", "verify", "done"];

export async function runCutover({
  preflight,
  stopWebUi,
  startWebUi,
  stopBackend,
  startBackendAttached,
  waitReady,
  verify,
  log = () => {},
  error = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  readyTimeoutMs = 60_000,
  pollMs = 500,
} = {}) {
  for (const [name, fn] of Object.entries({ preflight, stopWebUi, startWebUi, stopBackend, startBackendAttached, waitReady })) {
    if (typeof fn !== "function") throw new Error(`${name} is required`);
  }
  const started = now();
  const stages = [];

  /** Back to the pre-cutover state. Failures here are reported, never thrown: the operator must see them. */
  async function rollback() {
    log("Cutover rollback: returning to the in-process runtime");
    try {
      await stopBackend();
    } catch (err) {
      error(`Rollback could not stop the Backend: ${err instanceof Error ? err.message : String(err)}`);
      return false; // An unconfirmed Backend stop must not bring another runtime owner back.
    }
    try {
      await startWebUi({ ownsRuntime: true });
    } catch (err) {
      error(`Rollback could not restart the WebUI: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    return true;
  }

  const failed = async (stage, reason, blockers) => {
    const rolledBack = await rollback();
    return { ok: false, stage, reason, ...(blockers ? { blockers } : {}), rolledBack, stages };
  };

  // 1. Nothing may be running that would be lost, and the Backend must be the build we expect.
  stages.push("check");
  const preflightDeadline = now() + readyTimeoutMs;
  let preflightResult;
  for (;;) {
    preflightResult = await preflight();
    const blockers = preflightResult?.blockers ?? [];
    // Cold HTTP endpoints may not be observable yet. Work or unknown disk ownership never retries.
    if (preflightResult?.ok || blockers.length === 0 || now() >= preflightDeadline ||
      blockers.some(({ code }) => code !== "backend-unreachable" && code !== "goal-loop-state-unknown")) break;
    await sleep(pollMs);
  }
  if (!preflightResult?.ok) {
    log("Cutover refused: the preconditions are not met");
    return { ok: false, stage: "check", reason: "preflight", blockers: preflightResult?.blockers ?? [], rolledBack: false, stages };
  }

  // 2. Stop the old path first: the Backend must never attach while another owner is alive.
  stages.push("stop-old-path");
  try {
    await stopWebUi();
  } catch (err) {
    error(`Cutover could not stop the WebUI: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, stage: "stop-old-path", reason: "stop-failed", rolledBack: false, stages };
  }

  // 3. Attach the runtime to the Backend, then wait for real readiness (not the listening socket).
  stages.push("attach-backend");
  try {
    await stopBackend();
    await startBackendAttached();
    const deadline = now() + readyTimeoutMs;
    let ready = false;
    while (now() < deadline) {
      if (await waitReady()) {
        ready = true;
        break;
      }
      await sleep(pollMs);
    }
    if (!ready) return await failed("attach-backend", "not-ready");
  } catch (err) {
    error(`Cutover could not attach the runtime: ${err instanceof Error ? err.message : String(err)}`);
    return await failed("attach-backend", "attach-failed");
  }

  // 4. Bring the WebUI back as a client of the Backend: it must not own the runtime any more.
  stages.push("hand-over");
  try {
    await startWebUi({ ownsRuntime: false });
  } catch (err) {
    error(`Cutover could not restart the WebUI: ${err instanceof Error ? err.message : String(err)}`);
    return await failed("hand-over", "start-failed");
  }

  // 5. Confirm the hand-over from the outside: the WebUI must report a satisfied cutover and the
  // Backend must still be ready. A hand-over that only looks finished is rolled back.
  if (typeof verify === "function") {
    stages.push("verify");
    const verifyDeadline = now() + readyTimeoutMs;
    let verified = { ok: false, blockers: [] };
    try {
      for (;;) {
        verified = (await verify()) ?? { ok: false, blockers: [] };
        // A spawned WebUI is not yet listening. Any ownership/generation failure is still final.
        const blockers = verified.blockers ?? [];
        if (verified.ok || blockers.length === 0 || now() >= verifyDeadline ||
          blockers.some(({ code }) => code !== "webui-unreachable")) break;
        await sleep(pollMs);
      }
    } catch (err) {
      error(`Cutover verification failed: ${err instanceof Error ? err.message : String(err)}`);
      verified = { ok: false, blockers: [] };
    }
    if (!verified.ok) {
      error("Cutover verification did not pass; rolling back");
      return await failed("verify", "verify-failed", verified.blockers);
    }
  }

  stages.push("done");
  log(`Cutover complete in ${Math.round((now() - started) / 1000)}s`);
  return { ok: true, stage: "done", rolledBack: false, stages };
}
