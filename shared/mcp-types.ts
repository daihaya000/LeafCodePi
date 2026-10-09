/** Public MCP DTO vocabulary, with no SDK or credential-store dependency. */
export type McpAuthType = "none" | "bearer" | "oauth" | "headers" | "auto";
export type McpCredentialSource =
  | "none"
  | "config"
  | "environment"
  | "secure-store"
  | "oauth"
  | "headers";
export type McpCredentialStatus =
  | "present"
  | "missing"
  | "expired"
  | "unknown"
  | "unavailable"
  | "url-mismatch";

export type McpDto = {
  id: string;
  name: string;
  enabled: boolean;
  bundled: boolean;
  userConfigured: boolean;
  source: "stdio" | "http";
  /** A redacted endpoint suitable for display. */
  url?: string;
  authType: McpAuthType;
  credentialConfigured: boolean;
  credentialSource: McpCredentialSource;
  credentialStatus: McpCredentialStatus;
};
