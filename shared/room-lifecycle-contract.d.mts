export const ROOM_LIFECYCLE_ROUTES: Readonly<Record<string, readonly string[]>>;
export function roomLifecycleTarget(path: string): { route: string; params: Record<string, string> } | null;
export function roomLifecycleBodyLimit(path: string, method?: string): number;
export function publicRoom(value: unknown): Record<string, unknown> | null;
export function publicRoomLifecycleBody(route: string, value: unknown, status: number, method: string): Record<string, unknown> | null;
