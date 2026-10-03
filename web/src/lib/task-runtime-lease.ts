import { createTaskLeaseState, TaskLeaseService, type TaskLeaseState, type OrphanedTaskListener as CoreOrphanedTaskListener, type TaskLeaseLostListener as CoreTaskLeaseLostListener } from "@backend-core/task-runtime-lease.mjs";
import { dataDir } from "@/lib/paths";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { listTasks, patchTask } from "@/lib/store";
import type { TaskSummary } from "@/lib/types";

export { ORPHANED_WORKING_TASK_ERROR } from "@backend-core/task-runtime-lease.mjs";
export type OrphanedTaskListener = CoreOrphanedTaskListener<TaskSummary>;
export type TaskLeaseLostListener = CoreTaskLeaseLostListener;

// Preserve the existing process token, ownership, heartbeat and orphan backlog
// across Next route bundles and hot reloads, including pre-extraction states.
const globals = globalThis as typeof globalThis & {
  __leafcodeTaskLeaseState?: TaskLeaseState<TaskSummary>;
};
const state = globals.__leafcodeTaskLeaseState ??= createTaskLeaseState<TaskSummary>();
const service = new TaskLeaseService({
  dataDir,
  listTasks: () => [...listTasks(true), ...listTasks(true, "bot")],
  // Resolve store exports at call time; partial module mocks may omit unused ones.
  patchTask: (id, patch) => patchTask(id, patch),
  state,
});

export function acquireTaskLease(taskId: string): boolean { return service.acquireTaskLease(taskId); }
export function releaseTaskLease(taskId: string): void { service.releaseTaskLease(taskId); }
export function ownsTaskLease(taskId: string): boolean { return service.ownsTaskLease(taskId); }
export function hasActiveTaskLease(taskId: string): boolean { return service.hasActiveTaskLease(taskId); }
export function taskRuntimeLeasePath(taskId: string): string { return service.taskRuntimeLeasePath(taskId); }
export function setOrphanedTaskListener(listener: OrphanedTaskListener | null): void { service.setOrphanedTaskListener(listener); }
export function setLeaseLostListener(listener: TaskLeaseLostListener | null): void { service.setLeaseLostListener(listener); }
export function reconcileOrphanedWorkingTasks(): string[] {
  // Reads and warmups in a client must not consume the owner's restart-resume notification.
  if (localRuntimeBlocked()) return [];
  return service.reconcileOrphanedWorkingTasks();
}
