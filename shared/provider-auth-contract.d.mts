export const PROVIDER_AUTH_ROUTES: Readonly<Record<string, readonly string[]>>;
export const PROVIDER_AUTH_EVENTS_PATH: string;
export const PROVIDER_AUTH_EVENT_LIMIT: number;
export const PROVIDER_AUTH_BUFFER_LIMIT: number;
export function providerAuthTarget(path: string): { route: string; params: Record<string, string> } | null;
export function publicAuthOperation(input: unknown): { id: string; execution: "not-started" | "complete" | "unknown" } | null;
export function publicProviderAuthBody(route: string, input: unknown, status: number): Record<string, unknown> | null;
export function publicProviderLoginEvent(input: unknown): Record<string, unknown> | null;
