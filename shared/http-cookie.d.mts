export type ResponseCookieOptions = { path?: string; expires?: Date | number; maxAge?: number; domain?: string; secure?: boolean; httpOnly?: boolean; sameSite?: boolean | "lax" | "strict" | "none" };
export function setResponseCookie(response: Response, name: string, value: string, options?: ResponseCookieOptions, now?: number): Response;
export function requestCookie(headers: Headers, name: string): string | undefined;
