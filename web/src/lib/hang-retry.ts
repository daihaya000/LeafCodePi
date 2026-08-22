import type { UiMessage } from "./types";

/**
 * ハング watchdog が再送したプロンプトを識別するマーカー。
 * user メッセージ先頭に付与し、UI では非表示にする。
 */
export const HANG_RETRY_PREFIX = "<!-- leafcode-pi-hang-retry -->\n";

/** 再送プロンプトにマーカーを付ける。 */
export function markHangRetryPrompt(text: string): string {
  if (text.startsWith(HANG_RETRY_PREFIX)) return text;
  return `${HANG_RETRY_PREFIX}${text}`;
}

/** マーカー付き user メッセージかどうか。 */
export function isHangRetryUserMessage(message: UiMessage): boolean {
  if (message.role !== "user") return false;
  if (message.hangRetry) return true;
  const text = message.parts.find((part) => part.type === "text")?.text ?? "";
  return text.startsWith(HANG_RETRY_PREFIX);
}

/** 表示用にマーカーを除去する。 */
export function stripHangRetryPrefix(text: string): string {
  return text.startsWith(HANG_RETRY_PREFIX) ? text.slice(HANG_RETRY_PREFIX.length) : text;
}

/** 自動再開回数（transcript 内の hang-retry user 数）。 */
export function countHangRetryUserMessages(messages: UiMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (isHangRetryUserMessage(message)) count += 1;
  }
  return count;
}
