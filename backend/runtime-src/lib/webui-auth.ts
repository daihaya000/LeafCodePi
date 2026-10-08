import { createHash, timingSafeEqual } from "node:crypto";
import { expectedWebUiToken, webUiAuthRequired } from "./webui-auth-shared";
export {
  expectedWebUiToken,
  isPublicWebUiPath,
  WEBUI_AUTH_COOKIE,
  WEBUI_AUTH_COOKIE_OPTIONS,
  webUiAuthRequired,
} from "./webui-auth-shared";

/** Constant-time token compare for Node route handlers. */
export function tokensMatch(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  // Hash both sides so the compared buffers always have equal length (no length leak).
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Sensitive API mutations must authenticate at the route boundary as well as
 * through proxy.ts. This is deliberately fail-closed: relay administration
 * is unavailable until the Web UI token auth is configured.
 */
export function isWebUiRequestAuthorized(req: Request): boolean {
  if (!webUiAuthRequired()) return false;
  const authorization = req.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const cookie = req.headers.get("cookie")?.match(/(?:^|;\s*)leafcode-pi-token=([^;]+)/)?.[1] ?? "";
  // No `?token=` here: route-level authorization guards API calls, which must not take URL tokens.
  const expected = expectedWebUiToken();
  return [bearer, cookie].some((token) => tokensMatch(token, expected));
}