import type { AppStore } from "./app-store.mjs";
import type { ProjectDto, TaskSummary } from "@shared/types";

/** Compile-only checks: unresolved DTO imports must not silently degrade to any. */
export function checkAppStoreTypes(store: AppStore): void {
  const project: ProjectDto | undefined = store.getProject("project");
  const task = store.getTask("task");
  const expectedTask: TaskSummary | undefined = task;
  void project;
  void expectedTask;
  if (task) {
    // @ts-expect-error Shared task titles are strings, not numbers.
    const wrongTitle: number = task.title;
    void wrongTitle;
  }
  // @ts-expect-error Task patches must use the shared ThinkingLevel union.
  store.patchTask("task", { thinkingLevel: "invalid-thinking-level" });
  // @ts-expect-error Project names remain string DTO fields.
  store.patchProject("project", { name: 123 });
}
