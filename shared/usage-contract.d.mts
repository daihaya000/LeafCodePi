export const USAGE_ROUTES: Readonly<Record<string, readonly string[]>>;
export function usageTarget(path: string): { route: string; params: Record<string, string> } | null;
export function usageExternalCommand(path: string, method: string): boolean;
export function publicUsageOperation(value: unknown): { id: string; execution: "not-started" | "complete" | "unknown" } | null;
export function publicUsageBody(route: string, input: unknown, status: number): Record<string, unknown> | null;
