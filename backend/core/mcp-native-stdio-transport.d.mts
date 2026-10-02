import type { LoadedMcpConfig, McpTransportFactory } from "@earendil-works/pi-coding-agent";
/** Inert PRIVATE constructor. SDK-validated snapshot and authority must belong to the same
 * prepared owner binding. Absolute executables only (Windows .exe/.com); no PATH/.cmd/HTTP/
 * !command fallback. Env references use only the explicit detached base env; inheritEnv=false.
 * Start/synchronous JSON-RPC listener dispatch are fenced; async listener work is not awaited.
 * Observed delivery failure immediately closes pending SDK requests, then attempts child cleanup.
 * Close observers are isolated; close/unsubscribe remain usable. No rollback, idle monitoring or
 * process drain. Send authorization is a separate gate. Close in finally. Not an executable-content
 * pin, sandbox, OS election, complete cutover or DTO. Source changes require explicit reprepare. */
export function createBackendMcpStdioTransportFactory(options: {
  snapshot: LoadedMcpConfig;
  configPath: string;
  sessionCwd: string;
  homeDir: string;
  environment: Readonly<Record<string, string>>;
  assertSnapshotOwner: () => void;
}): McpTransportFactory;
