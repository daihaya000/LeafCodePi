import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as owner from "./pi/harness";
import { getTask } from "./store";
import { clearGoalLoopAutoModel, setGoalLoopAutoModel } from "./pi/goal-loop-auto-model";
import { isGoalLoopSessionOwned, readGoalLoopState } from "./pi/goal-loop-state";

/** Explicit selection only: internal Auto-per-turn routing keeps its marker. */
export async function setTaskModel(...args: Parameters<typeof owner.setTaskModel>) {
  assertConfigurationOwner();
  const task = await owner.setTaskModel(...args);
  // Failure here is a partial outcome, not a rollback of the already-applied model.
  clearGoalLoopAutoModel(args[0]);
  return task;
}
export function setTaskThinkingLevel(...args: Parameters<typeof owner.setTaskThinkingLevel>) {
  assertConfigurationOwner();
  return owner.setTaskThinkingLevel(...args);
}
export function setTaskAgent(...args: Parameters<typeof owner.setTaskAgent>) {
  assertConfigurationOwner();
  return owner.setTaskAgent(...args);
}
export function setTaskGoalLoopAutoModel(id: string, enabled: boolean) {
  assertConfigurationOwner();
  const task = getTask(id);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  if (!enabled) {
    clearGoalLoopAutoModel(id);
    return { enabled: false };
  }
  const loop = readGoalLoopState(task.directory, task.sessionId);
  if (!loop || !isGoalLoopSessionOwned(loop)) throw Object.assign(new Error("Goal loop が実行中ではありません"), { status: 409 });
  if (!setGoalLoopAutoModel(id, loop)) throw Object.assign(new Error("Goal loop の状態を確認できません"), { status: 409 });
  return { enabled: true };
}
