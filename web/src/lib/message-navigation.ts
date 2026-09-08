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
 * ビューポート上端の行を基準に、前(-1)/後(+1)方向の次のジャンプ先を返す。
 * 追跡インデックスを持たないので、最下部まで読み進めた状態でも「一つ前」が
 * 直前の対象を飛ばして二つ前へ行くことがない。対象がなければ null。
 */
export function messageNavigationTarget(
  length: number,
  line: number,
  topOf: (index: number) => number,
  direction: -1 | 1,
): number | null {
  if (length <= 0) return null;
  // スムーズスクロール後の端数で同じ対象を再選択しないための余裕。
  const tolerance = 2;
  if (direction < 0) {
    for (let index = length - 1; index >= 0; index -= 1) {
      if (topOf(index) < line - tolerance) return index;
    }
    return 0;
  }
  for (let index = 0; index < length; index += 1) {
    if (topOf(index) > line + tolerance) return index;
  }
  return null;
}
