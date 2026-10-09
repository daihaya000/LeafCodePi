export const BOT_CODE_ROUTES: Readonly<Record<string, readonly string[]>>;
export function botCodeTarget(path: string): { route: string; params: Record<string, string> } | null;
export function botCodeBodyLimit(path: string): number;
export function publicBotCodeBody(route: string, value: unknown, status: number, method: string): Record<string, unknown> | null;
