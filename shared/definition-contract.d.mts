export const DEFINITION_ROUTES: Readonly<Record<string, readonly string[]>>;
export function definitionTarget(path: string): {route: string; params: Record<string, string>} | null;
export function definitionBodyLimit(route: string): number;
export function publicDefinitionBody(route: string, body: unknown, status: number): Record<string, unknown> | null;
