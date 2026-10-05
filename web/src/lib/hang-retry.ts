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

/**
 * Count for the hang-retry banner. Prefer the live server counter (reset to 0 on
 * the next real user turn). Fall back to "1" only when the latest user message is
 * still a hang-retry (SSE lag). Never sum historical hang-retry markers — that
 * kept the banner up for the life of the transcript.
 */
export function hangRetryNoticeCount(
  hangRetryCount: number,
  messages: readonly UiMessage[],
): number {
  if (hangRetryCount > 0) return hangRetryCount;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    return isHangRetryUserMessage(message) ? 1 : 0;
  }
  return 0;
}
