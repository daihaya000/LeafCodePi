import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  INITIAL_RESTART_PROBE,
  isRestartOverlayVisible,
  nextRestartProbe,
  OFFLINE_STREAK,
  type RestartProbeState,
} from "./webui-restart";

/** health の成否列を畳み込む。number は startedAt、null は到達不能。 */
function run(
  samples: readonly (number | null)[],
  from: RestartProbeState = INITIAL_RESTART_PROBE,
): { state: RestartProbeState; reloads: number } {
  let state = from;
  let reloads = 0;
  for (const sample of samples) {
    const step = nextRestartProbe(state, sample === null ? null : { startedAt: sample });
    state = step.state;
    if (step.reload) reloads += 1;
  }
  return { state, reloads };
}

describe("nextRestartProbe", () => {
  it("ignores failures before the first successful health check", () => {
    const { state, reloads } = run([null, null, null, null]);
    assert.equal(isRestartOverlayVisible(state), false);
    assert.equal(reloads, 0);
  });

  it("keeps the overlay hidden for a blip shorter than the streak", () => {
    const { state, reloads } = run([100, ...Array(OFFLINE_STREAK - 1).fill(null)]);
    assert.equal(isRestartOverlayVisible(state), false);
    assert.equal(reloads, 0);
  });

  it("shows the overlay once the failure streak is reached", () => {
    const { state } = run([100, ...Array(OFFLINE_STREAK).fill(null)]);
    assert.equal(isRestartOverlayVisible(state), true);
  });

  it("does not reload when the same process answers again", () => {
    const { state, reloads } = run([100, ...Array(OFFLINE_STREAK).fill(null), 100]);
    assert.equal(reloads, 0);
    assert.equal(isRestartOverlayVisible(state), false);
    assert.equal(state.failures, 0);
  });

  it("reloads when a different process answers", () => {
    const { reloads } = run([100, ...Array(OFFLINE_STREAK).fill(null), 200]);
    assert.equal(reloads, 1);
  });

  it("falls back to reloading after downtime when the server omits startedAt", () => {
    let state = nextRestartProbe(INITIAL_RESTART_PROBE, { startedAt: null }).state;
    for (let i = 0; i < OFFLINE_STREAK; i += 1) state = nextRestartProbe(state, null).state;
    assert.equal(isRestartOverlayVisible(state), true);
    assert.equal(nextRestartProbe(state, { startedAt: null }).reload, true);
  });

  it("marks offline after a single failure once a restart was requested", () => {
    const requested: RestartProbeState = {
      ...INITIAL_RESTART_PROBE,
      connected: true,
      requested: true,
      startedAt: 100,
    };
    const { state } = nextRestartProbe(requested, null);
    assert.equal(state.offline, true);
  });

  it("reloads when a requested restart happens before the first health check", () => {
    const requested = { ...INITIAL_RESTART_PROBE, requested: true };
    const down = nextRestartProbe(requested, null).state;
    assert.equal(down.offline, true);
    assert.equal(nextRestartProbe(down, { startedAt: 200 }).reload, true);
  });

  it("keeps the overlay up between a restart request and the server going down", () => {
    const requested: RestartProbeState = {
      ...INITIAL_RESTART_PROBE,
      connected: true,
      requested: true,
      startedAt: 100,
    };
    const { state, reload } = nextRestartProbe(requested, { startedAt: 100 });
    assert.equal(reload, false);
    assert.equal(isRestartOverlayVisible(state), true);
  });
});
