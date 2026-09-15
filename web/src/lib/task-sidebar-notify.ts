import type { TaskSummary } from "@/lib/types";

export function taskSidebarNotifyKey(
  task: Pick<TaskSummary, "id" | "status" | "title" | "goalLoopSummary" | "supervisorBotId">,
): string {
  const loop = task.goalLoopSummary;
  return [
    task.id,
    task.status,
    task.title,
    ...(task.supervisorBotId ? [task.supervisorBotId] : []),
    loop?.status ?? "",
    loop?.maxTurns ?? "",
    loop?.turnCount ?? "",
  ].join("|");
}
