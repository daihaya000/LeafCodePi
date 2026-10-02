export type McpPresetRequest =
  | { preset: "n8n"; url: string }
  | { preset: "slack"; clientId: string }
  | { preset: "google-workspace"; clientId: string; clientSecret: string }
  | { preset: "notion" };
export function parseMcpPresetRequest(body: unknown): { ok: true; value: McpPresetRequest } | { ok: false };
export type McpPublicReload = { reloaded: number; deferred: number; failed: number; errors: string[] };
export function publicMcpReload(value: unknown): McpPublicReload | null;
