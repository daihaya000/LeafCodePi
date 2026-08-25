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
 * Return the target currently at or above the viewport line. Keeping the last
 * reached target makes the next button select the next message instead of
 * skipping the first target below the current scroll position.
 */
export function messageNavigationIndex(
  length: number,
  currentIndex: number,
  line: number,
  topOf: (index: number) => number,
): number {
  if (length <= 0) return 0;
  let index = Math.min(Math.max(currentIndex, 0), length - 1);
  while (index + 1 < length && topOf(index + 1) <= line) index += 1;
  while (index > 0 && topOf(index) > line) index -= 1;
  return index;
}
