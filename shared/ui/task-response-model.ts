import type { TaskSummary } from "@shared/types";

type ResponseModel = NonNullable<TaskSummary["responseModel"]>;

/** Keep the responding model separate from the route selected for the next turn. */
export function taskResponseModel(
  task: Pick<TaskSummary, "providerID" | "modelID" | "responseModel">,
  messages: readonly unknown[] = [],
  activeModel?: { providerID?: string; modelID?: string },
): ResponseModel | undefined {
  if (activeModel?.providerID && activeModel.modelID) {
    return { providerID: activeModel.providerID, modelID: activeModel.modelID };
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const row = message as Record<string, unknown>;
    if (row.role === "assistant" && typeof row.provider === "string" && row.provider && typeof row.model === "string" && row.model) {
      return { providerID: row.provider, modelID: row.model };
    }
  }
  return task.responseModel ?? (task.providerID && task.modelID
    ? { providerID: task.providerID, modelID: task.modelID }
    : undefined);
}
