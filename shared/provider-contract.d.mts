export const PROVIDER_ROUTES: Readonly<Record<string, readonly string[]>>;
export function providerTarget(path: string): { route: string; params: Record<string, string> } | null;
export function publicProviderBody(route: string, input: unknown, status: number): Record<string, unknown> | null;
