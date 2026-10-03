/**
 * How a session tells the Pi SDK which tools it may use.
 *
 * SDK `tools` is a hard allowlist: a tool that is not named is never registered, so it can be
 * neither declared nor called by `codemode`. Native MCP registers `mcp__<server>__<tool>` and the
 * resource tools only after its servers connect, so those names cannot be listed up front. A
 * session that uses native MCP therefore denies by exclusion instead: every tool known at load time
 * that is not wanted is excluded, and tools registered later (MCP) stay available.
 * The default persona has no tool-name restriction at all; execution permissions remain separate.
 */

/** Tools the SDK registers itself; every other name comes from an extension. */
const BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/** Registered by the native MCP extensions; activated by them when a server needs it. */
const NATIVE_MCP_TOOL_NAMES = ["codemode"];

export type SessionToolSelection =
  | { tools: string[] }
  | { excludeTools: string[]; initialActive: string[]; preserveActive?: boolean };

/**
 * Native MCP registers `mcp__<server>__<tool>` after its servers connect, so a session that expects
 * them must deny by exclusion instead of listing every name up front. An active provider that produced
 * no factory registered nothing, so it stays on the strict allowlist.
 */
export function shouldUseDynamicMcpTools(input: {
  active: boolean;
  factoryCount: number;
  hasAgentTools?: boolean;
  hasBotTools?: boolean;
}): boolean {
  return input.active && input.factoryCount > 0 && !input.hasAgentTools && !input.hasBotTools;
}

export function sessionToolSelection(input: {
  tools: readonly string[];
  /** The default Code persona inherits every registered tool, including later registrations. */
  allTools?: boolean;
  /** Native MCP is active and the session has no agent or Bot allowlist. */
  dynamicMcpTools: boolean;
  /** Names every loaded extension registered while loading. */
  registered: Iterable<string>;
}): SessionToolSelection {
  const tools = [...input.tools];
  // Do not snapshot the registry into a hard allowlist: future extensions/MCP must remain reachable.
  // Keep extension activation defaults as well as the platform-aware Code base loadout.
  if (input.allTools) return { excludeTools: [], initialActive: tools, preserveActive: true };
  if (!input.dynamicMcpTools) return { tools };
  const allowed = new Set([...tools, ...NATIVE_MCP_TOOL_NAMES]);
  const known = new Set([...BUILTIN_TOOL_NAMES, ...input.registered]);
  return {
    excludeTools: [...known].filter((name) => !allowed.has(name)).sort(),
    initialActive: tools,
  };
}
