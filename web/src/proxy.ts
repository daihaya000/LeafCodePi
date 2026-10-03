import { NextRequest, NextResponse } from "next/server";
import {
  expectedWebUiToken,
  isPublicWebUiPath,
  tokensMatch,
  WEBUI_AUTH_COOKIE,
  WEBUI_AUTH_COOKIE_OPTIONS,
  webUiAuthRequired,
} from "@/lib/webui-auth-shared";

/**
 * `?token=` only exists so a link can sign a browser in once (the page request is redirected to
 * a clean URL and a cookie is set). API routes never accept it: URLs end up in logs and referrers.
 */
function tokenFromRequest(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookie = req.cookies.get(WEBUI_AUTH_COOKIE)?.value;
  if (cookie) return cookie;
  if (req.nextUrl.pathname.startsWith("/api/")) return null;
  return req.nextUrl.searchParams.get("token");
}

export function proxy(req: NextRequest) {
  if (!webUiAuthRequired()) return NextResponse.next();

  const pathname = req.nextUrl.pathname;
  const cookie = req.cookies.get(WEBUI_AUTH_COOKIE)?.value;
  const expected = expectedWebUiToken();
  if (pathname === "/login" && cookie && tokensMatch(cookie, expected)) {
    const next = req.nextUrl.searchParams.get("next");
    const destination = next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
      ? new URL(next, req.url)
      : new URL("/", req.url);
    if (destination.pathname === "/login") destination.pathname = "/";
    const res = NextResponse.redirect(destination);
    res.cookies.set(WEBUI_AUTH_COOKIE, cookie, WEBUI_AUTH_COOKIE_OPTIONS);
    return res;
  }
  if (isPublicWebUiPath(pathname)) return NextResponse.next();

  const given = tokenFromRequest(req);
  if (given && tokensMatch(given, expected)) {
    if (req.nextUrl.searchParams.get("token") === given && !pathname.startsWith("/api/")) {
      const url = req.nextUrl.clone();
      url.searchParams.delete("token");
      const res = NextResponse.redirect(url);
      res.cookies.set(WEBUI_AUTH_COOKIE, given, WEBUI_AUTH_COOKIE_OPTIONS);
      return res;
    }
    const res = NextResponse.next();
    // Keep a previously approved browser signed in while it continues to use the WebUI.
    if (cookie && tokensMatch(cookie, expected)) {
      res.cookies.set(WEBUI_AUTH_COOKIE, cookie, WEBUI_AUTH_COOKIE_OPTIONS);
    }
    return res;
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const login = new URL("/login", req.url);
  login.searchParams.set("next", pathname + req.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
