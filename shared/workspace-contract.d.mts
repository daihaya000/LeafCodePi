export const WORKSPACE_ROUTES: Readonly<Record<string, readonly string[]>>;
export const WORKSPACE_BODY_LIMIT: number;
export function workspaceTarget(path: string): { route: string; params: { id?: string } } | null;
export function publicWorkspaceBody(route: string, input: unknown, status: number): Record<string, unknown> | null;
