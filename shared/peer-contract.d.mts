export const PEER_ROUTES: Readonly<Record<string, readonly string[]>>;
export const PEER_AUTHORIZATION_HEADER: string;
export function peerTarget(path: string): { route: string; params: Record<string, string> } | null;
export function peerFacing(path: string): boolean;
export function peerCommand(path: string, method: string): boolean;
export function publicPeerBody(route: string, input: unknown, status: number): Record<string, unknown> | null;
