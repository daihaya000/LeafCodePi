export const PROJECT_ROUTES: Readonly<Record<string, readonly string[]>>;
export const PROJECT_BODY_LIMIT: number;
export function projectTarget(path: string): { route: string; params: Record<string, string> } | null;
export function publicProjectOperation(value: unknown): { id: string; execution: "not-started" | "unknown" | "complete" } | null;
export function publicProjectBody(value: unknown, status: number): Record<string, unknown> | null;
