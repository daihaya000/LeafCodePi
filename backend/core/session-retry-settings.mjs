/**
 * Provider-limit routing may suppress SDK retries for this run only.
 * AgentSession.setAutoRetryEnabled persists to global settings: another session
 * opened before restoration (or a crash) would inherit the temporary false.
 */
export function overrideSessionAutoRetry(session, enabled) {
  const manager = session?.settingsManager;
  if (typeof manager?.applyOverrides !== "function") return false;
  manager.applyOverrides({ retry: { enabled } });
  return true;
}
