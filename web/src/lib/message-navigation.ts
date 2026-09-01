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

/**
 * Return the first target at or below the viewport line. The navigation
 * buttons move from this target, so the previous button selects the message
 * currently visible instead of skipping it.
 */
export function messageNavigationIndex(
  length: number,
  currentIndex: number,
  line: number,
  topOf: (index: number) => number,
): number {
  if (length <= 0) return 0;
  let index = Math.min(Math.max(currentIndex, 0), length - 1);
  while (index < length && topOf(index) < line) index += 1;
  while (index > 0 && topOf(index - 1) >= line) index -= 1;
  return Math.min(index, length - 1);
}
