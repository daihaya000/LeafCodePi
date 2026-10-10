export const WEBUI_AUTH_COOKIE = "leafcode-pi-token";
export const WEBUI_AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

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
  if (!given || !expected) return false;
  // Always walk the expected length and fold the length difference into the result, so timing
  // depends on the secret only and never on how long the guess is.
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= (given.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function isPublicWebUiPath(pathname: string): boolean {
  if (pathname === "/login") return true;
  // Legacy root/login layouts already expose these display-only values publicly.
  if (pathname === "/webui-bootstrap.json") return true;
  if (pathname.startsWith("/api/auth/webui")) return true;
  if (pathname === "/api/health") return true;
  if (pathname === "/api/host-probe") return true;
  // Peer LCPs authenticate with their own bearer token inside these routes (docs/plans/peer-auth-share.md).
  if (
    pathname === "/api/peer-auth/list" ||
    pathname === "/api/peer-auth/resolve" ||
    pathname === "/api/peer-auth/usage"
  ) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  return false;
}
