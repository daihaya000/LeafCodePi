import { COMPUTER_USE_TOOL_NAMES } from "@/lib/types";

/** Settings candidates, not a runtime allowlist or a snapshot of registered tools.
 * Extension/MCP names outside this list can be added explicitly in the editor.
 * Bot-only tools must not be mixed into the Code permission vocabulary.
 */
export const AGENT_TOOL_NAMES = [
  "read", "write", "edit", "bash", "powershell", "question", "grep", "find", "ls",
  "memory_search", "memory_add", "memory_replace", "memory_remove", "session_search",
  "skill_manage", "subagent", "subagent_wait", "contact_supervisor", "structured_output",
  "todowrite", "tool_search", "jev_judge", "intercom", "web_search", "source_check",
  "fetch_content", "get_search_content", "codemode", ...COMPUTER_USE_TOOL_NAMES,
] as const;
