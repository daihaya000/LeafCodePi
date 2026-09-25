import type { TaskSummary } from "@/lib/types";

export function taskSidebarNotifyKey(
  task: Pick<TaskSummary, "id" | "status" | "title" | "label" | "goalLoopSummary" | "supervisorBotId">,
): string {
  const loop = task.goalLoopSummary;
  return [
    task.id,
    task.status,
    task.title,
    ...(task.supervisorBotId ? [task.supervisorBotId] : []),
    ...(task.label ? [`label:${task.label}`] : []),
    loop?.status ?? "",
    loop?.maxTurns ?? "",
    loop?.turnCount ?? "",
  ].join("|");
}
