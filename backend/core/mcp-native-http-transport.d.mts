import type { LoadedMcpConfig, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import type { McpFetch } from "@earendil-works/pi-mcp";
/** PRIVATE inert constructor. Snapshot + authority must belong to the same prepared binding.
 * Explicit header variables/fetch only. HTTPS/loopback HTTP; no redirect/!command/template fallback.
 * SDK authProvider preserved; its internal refresh/network/issuer permissions remain separate gates.
 * Owner fetch must enforce destination policy. JSON/SSE synchronous listener dispatch is fenced
 * before/after each callback (async listener work is not awaited/cancelled). Observed failure
 * immediately closes delivery/pending requests, then attempts cleanup.
 * Close listeners are isolated; unsubscribe stays usable. Started effects/already delivered messages
 * cannot be undone, response/SSE bodies are not fully cancelled. Close remains best-effort usable.
 * Not a DTO, DNS/SSRF sandbox, complete credential migration, writer quiescence or activation. */
export function createBackendMcpHttpTransportFactory(options: {
  snapshot: LoadedMcpConfig;
  configPath: string;
  sessionCwd: string;
  variables: Readonly<Record<string, string>>;
  fetch: McpFetch;
  assertSnapshotOwner: () => void;
}): McpTransportFactory;
