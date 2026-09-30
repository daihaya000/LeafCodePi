import type { UiMessage } from "./types";
import { HANG_RETRY_PREFIX } from "@backend-core/prompt-markers.mjs";

/**
 * ハング watchdog が再送したプロンプトを識別するマーカー。
 * user メッセージ先頭に付与し、UI では非表示にする。
 */
export { HANG_RETRY_PREFIX, markHangRetryPrompt, stripHangRetryPrefix } from "@backend-core/prompt-markers.mjs";

/** マーカー付き user メッセージかどうか。 */
export function isHangRetryUserMessage(message: UiMessage): boolean {
  if (message.role !== "user") return false;
  if (message.hangRetry) return true;
  const text = message.parts.find((part) => part.type === "text")?.text ?? "";
  return text.startsWith(HANG_RETRY_PREFIX);
}

/** 自動再開回数（transcript 内の hang-retry user 数）。 */
export function countHangRetryUserMessages(messages: UiMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (isHangRetryUserMessage(message)) count += 1;
  }
  return count;
}
