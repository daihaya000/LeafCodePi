export const LIVE_EVENT_PATH: string;
export const LIVE_EVENT_HEADERS: readonly string[];
export function liveEventTarget(route:string): {route:string;id:string;kind:"bots"|"room"|"task"|"bot"}|null;
