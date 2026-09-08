import { timingSafeEqual } from "node:crypto";
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
