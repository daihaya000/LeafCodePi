export type McpPublicAuthSnapshot = {
  name: string;
  /** Empty compatibility field: the owner's filesystem path is not public. */
  configPath: "";
  url?: string;
  authType: "none" | "bearer" | "oauth" | "headers" | "auto";
  credentialConfigured: boolean;
  credentialSource: "none" | "config" | "environment" | "secure-store" | "oauth" | "headers";
  credentialStatus: "present" | "missing" | "expired" | "unknown" | "unavailable" | "url-mismatch";
};
export function publicMcpAuthSnapshot(value: unknown): McpPublicAuthSnapshot | null;
