import { timingSafeEqual } from "node:crypto";
import { expectedWebUiToken, webUiAuthRequired } from "./webui-auth-shared";
export {
  expectedWebUiToken,
  isPublicWebUiPath,
  WEBUI_AUTH_COOKIE,
  webUiAuthRequired,
} from "./webui-auth-shared";

/** Constant-time token compare for Node route handlers. */
export function tokensMatch(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
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
  let queryToken = "";
  try { queryToken = new URL(req.url).searchParams.get("token")?.trim() ?? ""; } catch { /* malformed test URL */ }
  const expected = expectedWebUiToken();
  return [bearer, cookie, queryToken].some((token) => tokensMatch(token, expected));
}