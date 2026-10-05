import { RESTART_LABELS, type RestartTarget } from "./host-restart-copy";

const PROBE_TIMEOUT_MS = 2_500;

/**
 * The Host refuses a Backend / tray-host restart while a Goal Loop is live (the runtime owner
 * would kill it). Ask the same owner first so the operator learns that before confirming,
 * instead of after a confirm → POST → 409 round trip. WebUI restarts keep sessions on the
 * independent Backend, so they are left to the Host's own guard.
 *
 * Fails open: an unknown state returns null and the Host stays authoritative.
 */
export async function liveGoalLoopRestartBlock(
  target: RestartTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (target === "webui") return null;
  try {
    const response = await fetchImpl("/api/goal-loop/active", {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { active?: unknown } | null;
    const active = typeof body?.active === "number" && Number.isFinite(body.active) ? body.active : 0;
    if (active <= 0) return null;
    return `Goal Loop が ${active} 件実行中のため${RESTART_LABELS[target]}は再起動できません。ループを停止・完了してから再試行してください。`;
  } catch {
    return null;
  }
}
