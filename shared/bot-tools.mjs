/**
 * The Bot tool vocabulary, as data.
 *
 * It lives here rather than in the TypeScript contract so the Backend process can read it too: the
 * bot store validates stored tool names against this list, and both processes must agree on it.
 * `shared/types.ts` re-exports it with the narrower `BotToolName` type for the Web app.
 */

/**
 * Every tool a Bot may be configured with, in the order the Bot settings UI shows them.
 *
 * MCP tools are not listed: native MCP registers `mcp__<server>__<tool>` only after a server
 * connects, so there is no fixed name to offer. The old `mcp` gateway entry named a tool nothing
 * registers any more (the adapter was retired), so it was a checkbox that could never work. Stored
 * Bot allowlists keep such names verbatim (`normalizeBotTools`), so removing it here never erases
 * a saved value.
 */
export const BOT_TOOL_NAMES = [
  "read", "write", "edit", "bash", "powershell", "question", "grep", "find", "ls",
  "memory_search", "memory_add", "memory_replace", "memory_remove", "session_search",
  "skill_manage", "subagent", "todowrite", "show_image", "show_video", "show_audio", "tool_search", "jev_judge", "intercom",
  "web_search", "source_check", "fetch_content", "get_search_content", "contact_supervisor",
  "subagent_wait", "structured_output", "task_mutation_decision", "watchdog_permission_decision",
  "watchdog_warn",
];

/** Tools that mutate state or coordinate subagents internally; off by default for Bots. */
export const BOT_DEFAULT_DISABLED_TOOL_NAMES = [
  "write", "edit", "bash", "powershell", "subagent", "todowrite",
  "contact_supervisor", "subagent_wait", "structured_output", "task_mutation_decision",
  "watchdog_permission_decision", "watchdog_warn",
];

const BOT_DEFAULT_DISABLED_TOOL_SET = new Set(BOT_DEFAULT_DISABLED_TOOL_NAMES);

/** The tools a new Bot gets unless the user enables more. */
export const BOT_DEFAULT_TOOL_NAMES = BOT_TOOL_NAMES.filter((tool) => !BOT_DEFAULT_DISABLED_TOOL_SET.has(tool));
