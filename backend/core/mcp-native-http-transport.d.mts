import type { LoadedMcpConfig, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import type { McpFetch } from "@earendil-works/pi-mcp";
/** PRIVATE inert constructor. Snapshot + authority must belong to the same prepared binding.
 * Explicit header variables/fetch only. HTTPS/loopback HTTP; no redirect/!command/template fallback.
 * SDK authProvider preserved; its internal refresh/network/issuer permissions remain separate gates.
 * Owner fetch must enforce destination policy. Start/send/fetch fences do not cancel started effects
 * or fully fence response/SSE bodies. Close remains best-effort usable after revocation. Not a DTO,
 * DNS/SSRF sandbox, complete credential migration, writer quiescence or production activation. */
export function createBackendMcpHttpTransportFactory(options: {
  snapshot: LoadedMcpConfig;
  configPath: string;
  sessionCwd: string;
  variables: Readonly<Record<string, string>>;
  fetch: McpFetch;
  assertSnapshotOwner: () => void;
}): McpTransportFactory;
