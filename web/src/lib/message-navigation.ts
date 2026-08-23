import type { UiMessage } from "./types";

/**
 * Prefer user prompts, but keep navigation available for Goal Loop runs whose
 * prompts are hidden custom messages and therefore have no projected user row.
 */
export function messageNavigationIds(messages: Pick<UiMessage, "id" | "role">[]): string[] {
  const userIds = messages.filter((message) => message.role === "user").map((message) => message.id);
  if (userIds.length > 0) return userIds;
  return messages
    .filter((message) => message.role !== "compaction")
    .map((message) => message.id);
}
