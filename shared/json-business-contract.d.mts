export const JSON_BUSINESS_PATH: string;
export const JSON_BUSINESS_HEADERS: Readonly<{origin: string; host: string; authorized: string}>;
export const JSON_BUSINESS_ROUTES: Readonly<Record<string, readonly string[]>>;
export const JSON_BUSINESS_BODY_LIMIT: number;
export const JSON_BUSINESS_RESPONSE_LIMIT: number;
export function jsonBusinessTimeout(route: string): number;
export function jsonBusinessMutates(route: string, method: string): boolean;
export type JsonBusinessResult = { status: number; headers: Record<string, string>; body: Record<string, unknown> | null };
export function publicJsonBusinessResult(route: string, value: unknown): JsonBusinessResult | null;
