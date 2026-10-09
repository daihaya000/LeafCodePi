export const ROOM_CONVERSATION_ROUTES: Readonly<Record<string, readonly string[]>>;
export function roomConversationTarget(path: string): {route: string; params: Record<string,string>} | null;
export function roomConversationBodyLimit(path: string): number;
export function publicRoomConversationBody(route: string, value: unknown, status: number): Record<string,unknown> | null;
