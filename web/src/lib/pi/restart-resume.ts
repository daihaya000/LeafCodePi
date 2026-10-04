import { RestartResumeService, type RestartResumeDeps as CoreRestartResumeDeps } from "@backend-core/restart-resume.mjs";
import { dataDir } from "@/lib/paths";
import { ORPHANED_WORKING_TASK_ERROR } from "@/lib/task-runtime-lease";
import type { TaskSummary } from "@/lib/types";

export {
  RESTART_RESUME_PROMPT,
  RESTART_RESUME_DELAY_MS,
  RESTART_RESUME_STAGGER_MS,
  RESTART_RESUME_MAX_ATTEMPTS,
  RESTART_RESUME_WINDOW_MS,
  RESTART_RESUME_MAX_STALE_MS,
  restartResumeSkipReason,
  isGoalLoopRestartResumable,
} from "@backend-core/restart-resume.mjs";

export type RestartResumeDeps = CoreRestartResumeDeps<TaskSummary>;

// Compatibility entrypoint. Storage paths and task ownership remain unchanged.
const service = new RestartResumeService({ dataDir, orphanedTaskError: ORPHANED_WORKING_TASK_ERROR });

export function resumeOrphanedTask(snapshot: TaskSummary, deps: RestartResumeDeps): Promise<boolean> {
  return service.resumeOrphanedTask(snapshot, deps);
}

export function handleOrphanedTasks(snapshots: TaskSummary[], deps: RestartResumeDeps): string[] {
  return service.handleOrphanedTasks(snapshots, deps);
}
