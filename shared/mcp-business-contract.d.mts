export const MCP_BUSINESS_ROUTES: Readonly<Record<string, readonly string[]>>;
export function mcpBusinessTarget(path: string): { route: string; params: Record<string, string> } | null;
export function validMcpBusinessName(name: unknown): boolean;
export function mcpBusinessBodyLimit(path: string, method?: string): number;
export function publicMcpBusinessBody(route: string, value: unknown, status: number, method?: string): Record<string, unknown> | null;
