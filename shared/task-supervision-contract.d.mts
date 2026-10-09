export const TASK_SUPERVISION_ROUTES: Readonly<Record<string, readonly string[]>>;
export const TASK_SUPERVISION_BODY_LIMIT: number;
export function taskSupervisionTarget(path: string): { route: string; params: Record<string, string> } | null;
export function publicSubagentRun(value: unknown): Record<string, unknown> | null;
export function publicTaskSupervisionBody(route: string, value: unknown, status: number): Record<string, unknown> | null;
