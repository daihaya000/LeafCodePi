import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Explicit Code settings outrank both default inheritance and agent allowlists. */
export type CodeToolPolicy = { subagent: "allow" | "deny" };
const policies = new WeakMap<object, CodeToolPolicy>();
const policySessions = new WeakMap<CodeToolPolicy, WeakRef<AgentSession>>();

export function attachCodeToolPolicy(session: AgentSession, policy: CodeToolPolicy): void {
  policies.set(session, policy);
  policySessions.set(policy, new WeakRef(session));
}

/** SDK loadout deactivation clears all pending names, including MCP tools still reconnecting.
 * Preserve unrelated names, but never restore the tool explicitly denied by this rewrite.
 * The field is SDK-private: guard access and re-read it after the rewrite.
 */
export function preservingPendingToolNames(session: AgentSession, dropped: string, apply: () => void): void {
  const state = session as unknown as { _pendingToolNames?: unknown };
  const saved = state._pendingToolNames instanceof Set ? [...state._pendingToolNames] : [];
  apply();
  const pending = state._pendingToolNames;
  if (!(pending instanceof Set)) return;
  const active = new Set(session.getActiveToolNames());
  for (const name of saved) {
    if (typeof name === "string" && name !== dropped && !active.has(name)) pending.add(name);
  }
  pending.delete(dropped);
}

export function updateCodeSubagentPolicy(session: object, permission: "allow" | "deny"): void {
  const policy = policies.get(session);
  if (policy) policy.subagent = permission;
}

export function codeToolAllowed(policy: CodeToolPolicy, name: string): boolean {
  return name !== "subagent" || policy.subagent === "allow";
}

export function registerCodeToolPolicy(api: ExtensionAPI, policy: CodeToolPolicy): void {
  const enforceVisibility = () => {
    const active = api.getActiveTools();
    const permitted = active.filter((name) => codeToolAllowed(policy, name));
    if (permitted.length === active.length) return;
    const session = policySessions.get(policy)?.deref();
    if (session) {
      preservingPendingToolNames(session, "subagent", () => api.setActiveTools(permitted));
    } else {
      api.setActiveTools(permitted);
    }
  };
  api.on("session_start", enforceVisibility);
  api.on("before_agent_start", enforceVisibility);
  // Visibility alone is not authorization: SDK nested calls may reach inactive registered tools.
  api.on("tool_call", (event) => {
    if (!codeToolAllowed(policy, event.toolName)) {
      return { block: true, reason: "Subagent execution is disabled by the Code subagent permission setting." };
    }
  });
}
