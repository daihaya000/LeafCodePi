import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as harness from "./pi/harness";
import { getTask } from "./store";
import { listSubagentRuns } from "./pi/subagent-runs";
/** Reject Next before relay/outbox/SDK effects or registered-session artifact reads. */
export function handoffTaskToBot(...args: Parameters<typeof harness.handoffTaskToBot>) { assertConfigurationOwner(); return harness.handoffTaskToBot(...args); }
export function releaseTaskFromBot(...args: Parameters<typeof harness.releaseTaskFromBot>) { assertConfigurationOwner(); return harness.releaseTaskFromBot(...args); }
export function readTaskSubagentRuns(id: string, sinceMs?: number) {
  assertConfigurationOwner();
  const task = getTask(id);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  return listSubagentRuns({ sessionFile: task.sessionFile, cwd: task.directory,
    ...(Number.isFinite(sinceMs) ? { sinceMs } : {}) });
}
