import {
  refreshLiveSessionsForAgentDefinition as refreshLocally,
  reloadLiveSessionsContext as reloadLocally,
} from "@/lib/pi/harness";
import { forwardLiveSessionsReload } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

/**
 * Settings routes (AGENTS.md, SOUL, skills, MCP, agents) rebuild the context of live sessions after a
 * save. The sessions live in the owning Backend, so a client process has none to reload: it asks the
 * owner instead. There is no local fallback, and a Backend that cannot answer is an error the route
 * already reports (or logs, for the fire-and-forget callers).
 */
export type LiveSessionsReloadResult = Awaited<ReturnType<typeof reloadLocally>>;
export type LiveSessionsRefreshResult = ReturnType<typeof refreshLocally>;

function backendError(reason: string): Error {
  return new Error(`Backendで実行中セッションを更新できません (${reason})`);
}

export async function reloadLiveSessionsContext(): Promise<LiveSessionsReloadResult> {
  if (!localRuntimeBlocked()) return await reloadLocally();
  const forwarded = await forwardLiveSessionsReload({ action: "reload" });
  if (!forwarded.ok) throw backendError(forwarded.reason);
  return forwarded.result as LiveSessionsReloadResult;
}

export async function refreshLiveSessionsForAgentDefinition(agentName: string): Promise<LiveSessionsRefreshResult> {
  if (!localRuntimeBlocked()) return refreshLocally(agentName);
  const forwarded = await forwardLiveSessionsReload({ action: "refresh-agent", agentName });
  if (!forwarded.ok) throw backendError(forwarded.reason);
  return forwarded.result as LiveSessionsRefreshResult;
}
