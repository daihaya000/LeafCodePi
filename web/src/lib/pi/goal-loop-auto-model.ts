import { getSetting, setSetting } from "@/lib/pi/web-settings";

/**
 * Per-task marker: "the Composer is on Auto while this Goal Loop runs". The model is then
 * re-resolved before every Goal turn. The marker is bound to the loop's createdAt so a
 * marker left behind by an earlier loop on the same task never applies to a new one.
 * It lives in the shared settings file, so the Web and Backend processes both see it.
 */
const keyFor = (taskId: string) => `goal-loop-auto-model:${taskId}`;

type LoopIdentity = { createdAt?: unknown } | null | undefined;

function loopStamp(loop: LoopIdentity): string | null {
  return typeof loop?.createdAt === "string" && loop.createdAt ? loop.createdAt : null;
}

export function setGoalLoopAutoModel(taskId: string, loop: LoopIdentity): boolean {
  const stamp = loopStamp(loop);
  if (!stamp) return false;
  setSetting(keyFor(taskId), stamp);
  return true;
}

export function clearGoalLoopAutoModel(taskId: string): void {
  if (getSetting(keyFor(taskId)) !== null) setSetting(keyFor(taskId), null);
}

export function isGoalLoopAutoModel(taskId: string, loop: LoopIdentity): boolean {
  const stamp = loopStamp(loop);
  return stamp !== null && getSetting(keyFor(taskId)) === stamp;
}
