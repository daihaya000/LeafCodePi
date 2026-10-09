export const BACKEND_INFORMATION_ROUTES: Readonly<Record<string, readonly string[]>>;
export const BACKEND_INFORMATION_BODY_LIMIT: number;
export function backendInformationTarget(path: string): { route: string; params: Record<string, string> } | null;
export function publicBackendInformationBody(route: string, value: unknown, status: number, method?: string): Record<string, unknown> | null;
