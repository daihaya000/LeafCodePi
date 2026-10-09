export const BOT_LIFECYCLE_ROUTES: Readonly<Record<string, readonly string[]>>;
export function validBotLifecycleId(id: unknown): boolean;
export function botLifecycleTarget(path: string): { route: string; params: Record<string, string> } | null;
export function botLifecycleBodyLimit(path: string, method?: string): number;
export function publicBot(value: unknown): Record<string, unknown> | null;
export function publicBotLifecycleBody(route: string, value: unknown, status: number, method?: string): Record<string, unknown> | null;
