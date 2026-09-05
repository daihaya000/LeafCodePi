export const WEBUI_AUTH_COOKIE = "leafcode-pi-token";

/** Remote bind requires token auth when host sets LEAFCODE_PI_WEBUI_AUTH=required. */
export function webUiAuthRequired(): boolean {
  // A missing token is a broken auth configuration, not permission to bypass it.
  return process.env.LEAFCODE_PI_WEBUI_AUTH === "required";
}

export function expectedWebUiToken(): string {
  return process.env.LEAFCODE_PI_WEBUI_TOKEN?.trim() ?? "";
}

/** Edge-safe constant-time-ish token compare (no node:crypto). */
export function tokensMatch(given: string, expected: string): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function isPublicWebUiPath(pathname: string): boolean {
  if (pathname === "/login") return true;
  if (pathname.startsWith("/api/auth/webui")) return true;
  if (pathname === "/api/health") return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  return false;
}
