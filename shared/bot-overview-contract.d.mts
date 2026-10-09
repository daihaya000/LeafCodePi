export const BOT_OVERVIEW_ROUTES: Readonly<Record<string, readonly string[]>>;
export const BOT_OVERVIEW_BODY_LIMIT: number;
export function botOverviewTarget(path: string): { route: string; params: Record<string, string> } | null;
export function publicBotInbox(value: unknown): Record<string, unknown> | null;
export function publicSidebarRoom(value: unknown): Record<string, unknown> | null;
export function publicBotOverviewBody(route: string, value: unknown, status: number, method: string): Record<string, unknown> | null;
