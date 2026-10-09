export const BOT_CONVERSATION_ROUTES: Readonly<Record<string, readonly string[]>>;
export function botConversationTarget(path: string): { route: string; params: Record<string, string> } | null;
export function botConversationBodyLimit(path: string): number;
export function publicBotConversationBody(route: string, value: unknown, status: number): Record<string, unknown> | null;
