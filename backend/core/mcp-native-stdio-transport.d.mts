import type { LoadedMcpConfig, McpTransportFactory } from "@earendil-works/pi-coding-agent";
/** Inert PRIVATE constructor. SDK-validated snapshot and authority must belong to the same
 * prepared owner binding. Absolute executables only (Windows .exe/.com); no PATH/.cmd/HTTP/
 * !command fallback. Env references use only the explicit detached base env; inheritEnv=false.
 * Start fences do not cancel started effects. Close in finally. Not an executable-content pin,
 * sandbox, OS election, complete cutover or HTTP DTO. Source changes require explicit reprepare. */
export function createBackendMcpStdioTransportFactory(options: {
  snapshot: LoadedMcpConfig;
  configPath: string;
  sessionCwd: string;
  homeDir: string;
  environment: Readonly<Record<string, string>>;
  assertSnapshotOwner: () => void;
}): McpTransportFactory;
