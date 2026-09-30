/** Every tool a Bot may be configured with, in the order the Bot settings UI shows them. */
export const BOT_TOOL_NAMES: readonly string[];
/** Tools that mutate state or coordinate subagents internally; off by default for Bots. */
export const BOT_DEFAULT_DISABLED_TOOL_NAMES: readonly string[];
/** The tools a new Bot gets unless the user enables more. */
export const BOT_DEFAULT_TOOL_NAMES: readonly string[];
