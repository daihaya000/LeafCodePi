/**
 * How a session tells the Pi SDK which tools it may use.
 *
 * SDK `tools` is a hard allowlist: a tool that is not named is never registered, so it can be
 * neither declared nor called by `codemode`. Native MCP registers `mcp__<server>__<tool>` and the
 * resource tools only after its servers connect, so those names cannot be listed up front. A
 * session that uses native MCP therefore denies by exclusion instead: every tool known at load time
 * that is not wanted is excluded, and tools registered later (MCP) stay available.
 */

/** Tools the SDK registers itself; every other name comes from an extension. */
const BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/** Registered by the native MCP extensions; activated by them when a server needs it. */
const NATIVE_MCP_TOOL_NAMES = ["codemode"];

export type SessionToolSelection =
  | { tools: string[] }
  | { excludeTools: string[]; initialActive: string[] };

export function sessionToolSelection(input: {
  tools: readonly string[];
  /** Native MCP is active and the session has no agent or Bot allowlist. */
  dynamicMcpTools: boolean;
  /** Names every loaded extension registered while loading. */
  registered: Iterable<string>;
}): SessionToolSelection {
  const tools = [...input.tools];
  if (!input.dynamicMcpTools) return { tools };
  const allowed = new Set([...tools, ...NATIVE_MCP_TOOL_NAMES]);
  const known = new Set([...BUILTIN_TOOL_NAMES, ...input.registered]);
  return {
    excludeTools: [...known].filter((name) => !allowed.has(name)).sort(),
    initialActive: tools,
  };
}
