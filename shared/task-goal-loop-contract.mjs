import { publicGoalLoop } from "./task-lifecycle-contract.mjs";
import { publicAutoDecision, publicTaskOperation } from "./task-collection-contract.mjs";
export const TASK_GOAL_LOOP_ROUTES = Object.freeze({
  "tasks/[id]/goal-loop": ["GET", "POST", "PATCH"], "goal-loop/active": ["GET"],
});
export function taskGoalLoopTarget(path) {
  if (Object.hasOwn(TASK_GOAL_LOOP_ROUTES, path)) return { route: path, params: {} };
  const match = /^tasks\/([^/]+)\/goal-loop$/.exec(path);
  if (!match) return null;
  try { return { route: "tasks/[id]/goal-loop", params: { id: decodeURIComponent(match[1]) } }; }
  catch { return null; }
}
export function taskGoalLoopBodyLimit(path, method = "POST") {
  return taskGoalLoopTarget(path)?.route === "tasks/[id]/goal-loop" && method === "POST" ? 18 * 1024 * 1024 : 4096;
}
export function publicTaskGoalLoopBody(route, value, status, method) {
  if (!Object.hasOwn(TASK_GOAL_LOOP_ROUTES, route) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) {
    if (route === "goal-loop/active") {
      if (!Array.isArray(value.taskIds) || value.taskIds.some(id => typeof id !== "string") || value.active !== value.taskIds.length) return null;
      out.active = value.active; out.taskIds = [...value.taskIds];
    } else {
      if (!Object.hasOwn(value, "loop")) return null;
      out.loop = value.loop === null ? null : publicGoalLoop(value.loop);
      if (value.loop !== null && (!out.loop || !["queued","running","paused","verifying_completed","completed","blocked","stopped"].includes(out.loop.status))) return null;
      if (method && method !== "GET" && !out.loop) return null;
      if (value.agent !== undefined) { if (value.agent !== null && typeof value.agent !== "string") return null; out.agent = value.agent; }
      if (value.autoDecision !== undefined) { out.autoDecision = publicAutoDecision(value.autoDecision); if (!out.autoDecision) return null; }
    }
  }
  if (value.operation !== undefined) { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
  return out;
}
