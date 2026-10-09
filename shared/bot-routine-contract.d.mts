export const BOT_ROUTINE_ROUTES: Readonly<Record<string, readonly string[]>>;
export function botRoutineTarget(path: string): { route: string; params: Record<string, string> } | null;
export function botRoutineBodyLimit(path: string, method?: string): number;
export function publicRoutine(value: unknown): Record<string, unknown> | null;
export function publicBotRoutineBody(route: string, value: unknown, status: number, method: string): Record<string, unknown> | null;
