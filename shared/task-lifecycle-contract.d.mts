export const TASK_LIFECYCLE_ROUTES: Readonly<Record<string, readonly string[]>>;
export const TASK_LIFECYCLE_BODY_LIMIT: number;
export function taskLifecycleTarget(path: string): { route: string; params: Record<string, string> } | null;
export function validTaskLifecycleId(id: unknown): boolean;
export function publicTaskDetail(value: unknown): Record<string, unknown> | null;
export function publicTaskLifecycleBody(route: string, value: unknown, status: number): Record<string, unknown> | null;
