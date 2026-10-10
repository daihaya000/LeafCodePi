import { expectedWebUiToken, isPublicWebUiPath, tokensMatch, WEBUI_AUTH_COOKIE, WEBUI_AUTH_COOKIE_OPTIONS, webUiAuthRequired } from "../../shared/webui-auth-shared.ts";
import { requestCookie, setResponseCookie } from "../../shared/http-cookie.mjs";

/** Framework-free equivalent of the current Web proxy, including its authorization ordering. */
export function webAuthGate(request) {
  const url = new URL(request.url), pathname = url.pathname;
  if (!pathname.startsWith("/api/") && url.searchParams.has("token")) {
    url.searchParams.delete("token");
    return { response: new Response(null, { status: 307, headers: { location: url.href, "cache-control": "no-store", "referrer-policy": "no-referrer" } }) };
  }
  if (!webUiAuthRequired()) return {};
  const cookie = requestCookie(request.headers, WEBUI_AUTH_COOKIE), expected = expectedWebUiToken();
  if (pathname === "/login" && cookie && tokensMatch(cookie, expected)) {
    const next = url.searchParams.get("next");
    const destination = next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? new URL(next, url) : new URL("/", url);
    if (destination.pathname === "/login") destination.pathname = "/";
    return { response: setResponseCookie(new Response(null, { status: 307, headers: { location: destination.href } }), WEBUI_AUTH_COOKIE, cookie, WEBUI_AUTH_COOKIE_OPTIONS) };
  }
  if (isPublicWebUiPath(pathname)) return {};
  const auth = request.headers.get("authorization");
  const given = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : cookie;
  if (given && tokensMatch(given, expected)) {
    const refreshCookie = !!cookie && tokensMatch(cookie, expected);
    const cookieHeader = refreshCookie ? setResponseCookie(new Response(null), WEBUI_AUTH_COOKIE, cookie, WEBUI_AUTH_COOKIE_OPTIONS).headers.getSetCookie()[0] : undefined;
    return { refreshCookie, cookie, cookieHeader };
  }
  if (pathname.startsWith("/api/")) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const login = new URL("/login", url); login.searchParams.set("next", pathname + url.search);
  return { response: new Response(null, { status: 307, headers: { location: login.href } }) };
}
export function refreshAuthCookie(response, gate) {
  if (gate.refreshCookie) {
    const refreshed = gate.cookieHeader ?? setResponseCookie(new Response(null), WEBUI_AUTH_COOKIE, gate.cookie, WEBUI_AUTH_COOKIE_OPTIONS).headers.getSetCookie()[0];
    const existing = response.headers.getSetCookie();
    // Next emits middleware refresh first, then the route's cookie. The final value wins on rotation.
    response.headers.delete("set-cookie"); response.headers.append("set-cookie", refreshed);
    for (const cookie of existing) if (cookie !== refreshed) response.headers.append("set-cookie", cookie);
  }
  return response;
}
