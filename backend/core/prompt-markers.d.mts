export const BOT_PROMPT_PREFIX: string;
export const HANG_RETRY_PREFIX: string;

/** Marks a Bot-sent prompt; never double-marks. */
export function markBotPrompt(text: string): string;
/** Removes the Bot marker for display. */
export function stripBotPromptPrefix(text: string): string;
/** Marks a hang-watchdog resend; never double-marks. */
export function markHangRetryPrompt(text: string): string;
/** Removes the hang-resend marker for display. */
export function stripHangRetryPrefix(text: string): string;
/** Display text with every internal marker removed. */
export function stripPromptMarkers(text: string): string;
/** Whether the text is a Bot-sent prompt, even when wrapped by a hang resend. */
export function isBotPromptText(text: string): boolean;
/** Whether the text is a hang resend, even when a Bot marker was wrapped first. */
export function isHangRetryText(text: string): boolean;
