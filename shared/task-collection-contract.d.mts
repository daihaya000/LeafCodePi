export const TASK_COLLECTION_ROUTES: Readonly<Record<string, readonly string[]>>;
export const TASK_COLLECTION_BODY_LIMIT: number;
export function taskCollectionTarget(path: string): { route: string; params: Record<string, string> } | null;
export function publicTaskOperation(value: unknown): { id: string; execution: "not-started" | "unknown" | "complete" } | null;
export function publicAutoDecision(value: unknown): Record<string, unknown> | null;
export function publicTaskSummary(value: unknown): Record<string, unknown> | null;
export function publicTaskCollectionBody(value: unknown, status: number): Record<string, unknown> | null;
