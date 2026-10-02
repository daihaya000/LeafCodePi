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

/** Extension factory for a session loader. The provider is resolved when the loader runs (and again on
 * every reload), so a reload after a config write uses the newly published binding instead of
 * re-running factories bound to a retired one. A failed preparation yields no factories. */
export function nativeMcpExtensionFactory(sessionCwd) {
  return (api) => {
    for (const factory of resolveBackendMcpNativeSession(sessionCwd).factories) factory(api);
  };
}

/** Bundled entries to load as extension paths. Names stay complete so replaced upstream packages remain excluded. */
export function bundledPathsForNativeMcp(entries, active) {
  return active ? entries.filter((entry) => entry.name !== ADAPTER) : [...entries];
}
