import { paneTabIdForTask } from "@/lib/task-panes";
import type { TaskSummary } from "@/lib/types";

export function compareIsoUpdatedAtDescending(a: string, b: string): number {
  // Store timestamps use toISOString(), so codepoint order matches chronological order.
  return a === b ? 0 : a > b ? -1 : 1;
}

export function sidebarTaskComparator(pinnedTaskIds?: ReadonlySet<string>) {
  return (a: TaskSummary, b: TaskSummary) =>
    Number(pinnedTaskIds?.has(b.id)) - Number(pinnedTaskIds?.has(a.id)) ||
    Number(b.status === "working") - Number(a.status === "working") ||
    compareIsoUpdatedAtDescending(a.updatedAt, b.updatedAt);
}

export function projectsForSidebar<T extends { id: string }>(
  projects: readonly T[],
  projectOrder: readonly string[],
): T[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of [...projectOrder, ...projects.map((project) => project.id)]) {
    const project = byId.get(id);
    if (!project || seen.has(id)) continue;
    seen.add(id);
    ordered.push(project);
  }
  return ordered;
}

/** Code panes follow the sidebar's groups and rows, independent of collapsed/search state. */
export function orderPaneTabIdsForSidebar(
  tabIds: readonly string[],
  tasks: readonly TaskSummary[],
  projects: readonly { id: string; archived?: boolean }[],
  projectOrder: readonly string[],
  pinnedTaskIds?: ReadonlySet<string>,
): string[] {
  const orderedProjects = projectsForSidebar(projects, projectOrder);
  const projectRanks = new Map(
    [...orderedProjects.filter((project) => !project.archived), ...orderedProjects.filter((project) => project.archived)]
      .map((project, index) => [project.id, index + 1]),
  );
  const groupRank = (task: TaskSummary) => task.projectId == null ? 0 : projectRanks.get(task.projectId) ?? projectRanks.size + 1;
  const compareTasks = sidebarTaskComparator(pinnedTaskIds);
  const remaining = new Set(tabIds);
  const codeTasks = tasks.filter((task) => {
    const tabId = paneTabIdForTask(task);
    return task.kind !== "bot" && !tabId.startsWith("/bots/") && remaining.has(tabId);
  }).sort((a, b) => groupRank(a) - groupRank(b) || compareTasks(a, b));
  const ordered: string[] = [];
  for (const task of codeTasks) {
    const tabId = paneTabIdForTask(task);
    if (remaining.delete(tabId)) ordered.push(tabId);
  }
  // Keep Bot/Room tabs and targets absent from the task snapshot in their original order.
  return [...ordered, ...remaining];
}
