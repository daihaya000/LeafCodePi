/**
 * Internal markers that identify who sent a user prompt and whether it is a hang
 * resend. They live in the message text (the SDK transcript is the source of truth),
 * so the same vocabulary must be available to the Backend's prompt path. Every helper
 * is idempotent: marking twice is the same as marking once, and stripping is safe on
 * text that never carried the marker.
 */
export const BOT_PROMPT_PREFIX = "<!-- leafcode-pi-bot-prompt -->\n";
export const HANG_RETRY_PREFIX = "<!-- leafcode-pi-hang-retry -->\n";

/** Marks a Bot-sent prompt (Code delegation / Bot panel); never double-marks. */
export function markBotPrompt(text) {
  return text.startsWith(BOT_PROMPT_PREFIX) ? text : `${BOT_PROMPT_PREFIX}${text}`;
}

/** Removes the Bot marker for display. */
export function stripBotPromptPrefix(text) {
  return text.startsWith(BOT_PROMPT_PREFIX) ? text.slice(BOT_PROMPT_PREFIX.length) : text;
}

/** Marks a hang-watchdog resend; never double-marks. */
export function markHangRetryPrompt(text) {
  if (text.startsWith(HANG_RETRY_PREFIX)) return text;
  return `${HANG_RETRY_PREFIX}${text}`;
}

/** Removes the hang-resend marker for display. */
export function stripHangRetryPrefix(text) {
  return text.startsWith(HANG_RETRY_PREFIX) ? text.slice(HANG_RETRY_PREFIX.length) : text;
}

/** Display text with every internal marker removed (hang resend outermost). */
export function stripPromptMarkers(text) {
  return stripBotPromptPrefix(stripHangRetryPrefix(text));
}

/** Whether the text is a Bot-sent prompt, also when a hang resend wrapped it. */
export function isBotPromptText(text) {
  return stripHangRetryPrefix(text).startsWith(BOT_PROMPT_PREFIX);
}

/** Whether the text is a hang resend, also when a Bot marker was wrapped first. */
export function isHangRetryText(text) {
  return stripBotPromptPrefix(text).startsWith(HANG_RETRY_PREFIX);
}
