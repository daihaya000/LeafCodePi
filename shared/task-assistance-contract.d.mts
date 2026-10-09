export const TASK_ASSISTANCE_ROUTES: Readonly<Record<string, readonly string[]>>;
export function taskAssistanceTarget(path: string): { route: string; params: Record<string, string> } | null;
export function taskAssistanceBodyLimit(path: string): number;
export function taskAssistanceCancelsOnDisconnect(path: string): boolean;
export function publicTaskAssistanceBody(route: string, value: unknown, status: number, method?: string): Record<string, unknown> | null;
