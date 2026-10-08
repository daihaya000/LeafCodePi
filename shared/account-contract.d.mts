export const ACCOUNT_ROUTES: Readonly<Record<string, readonly string[]>>;
export function accountTarget(path: string): { route: string; params: Record<string, string> } | null;
export function publicAccountBody(route: string, input: unknown, status: number): Record<string, unknown> | null;
