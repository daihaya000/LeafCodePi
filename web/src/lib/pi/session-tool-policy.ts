import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Explicit Code settings outrank both default inheritance and agent allowlists. */
export type CodeToolPolicy = { subagent: "allow" | "deny" };
const policies = new WeakMap<object, CodeToolPolicy>();

export function attachCodeToolPolicy(session: object, policy: CodeToolPolicy): void {
  policies.set(session, policy);
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
    if (permitted.length !== active.length) api.setActiveTools(permitted);
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
