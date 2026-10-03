const ADAPTER = "leafcode-mcp-adapter";
let provider;

/** INTERNAL process-local switch. Unset (default) keeps the legacy adapter path untouched. When a
 * provider is installed, sessions get the native MCP factories and the bundled adapter is not loaded
 * (no dual operation). The provider is expected to be `preparedRuntime.forSession`; installing and
 * replacing it is an explicit Backend activation step and is not performed anywhere yet. */
export function setBackendMcpNativeSessionProvider(next) {
  if (next !== undefined && (typeof next !== "function" || next.constructor?.name === "AsyncFunction")) {
    throw new Error("MCP native session provider invalid");
  }
  provider = next;
}

/** Decides the MCP extension source for one session. Never falls back to the adapter once native is
 * active: a failed preparation yields no MCP factories plus sanitized issue codes. */
export function resolveBackendMcpNativeSession(sessionCwd) {
  if (!provider) return { active: false, factories: [], issues: [] };
  let result;
  try { result = provider(sessionCwd); } catch { return { active: true, factories: [], issues: [{ code: "native-session-provider-failed" }] }; }
  if (result && result.ok === true && Array.isArray(result.factories)) return { active: true, factories: [...result.factories], issues: [] };
  const issues = Array.isArray(result?.issues) ? result.issues.map((issue) => ({ code: typeof issue?.code === "string" ? issue.code : "native-session-unavailable" })) : [];
  return { active: true, factories: [], issues: issues.length ? issues : [{ code: "native-session-unavailable" }] };
}

/** Extension factory for a session loader. Resolve the provider on every load/reload, never replaying
 * a retired binding. Without native MCP, the host may supply standalone codemode; it does not activate
 * MCP or restore the retired adapter. An active but failed provider never uses this fallback. */
export function nativeMcpExtensionFactory(sessionCwd, standaloneCodemode) {
  return (api) => {
    const nativeMcp = resolveBackendMcpNativeSession(sessionCwd);
    if (!nativeMcp.active) return standaloneCodemode?.(api);
    // Native factories are async: hand the pending result back to the loader (sequentially, in order)
    // so a failed registration is reported and finishes before later extensions (tool_search/excludeTools).
    let pending;
    for (const factory of nativeMcp.factories) {
      if (pending) { pending = pending.then(() => factory(api)); continue; }
      const result = factory(api);
      if (result && typeof result.then === "function") pending = Promise.resolve(result);
    }
    return pending;
  };
}

/** Bundled entries to load as extension paths. Names stay complete so replaced upstream packages remain excluded. */
export function bundledPathsForNativeMcp(entries, active) {
  return active ? entries.filter((entry) => entry.name !== ADAPTER) : [...entries];
}
