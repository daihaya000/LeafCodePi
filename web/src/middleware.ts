import { NextRequest, NextResponse } from "next/server";
import {
  expectedWebUiToken,
  isPublicWebUiPath,
  tokensMatch,
  WEBUI_AUTH_COOKIE,
  webUiAuthRequired,
} from "@/lib/webui-auth-shared";

function tokenFromRequest(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookie = req.cookies.get(WEBUI_AUTH_COOKIE)?.value;
  if (cookie) return cookie;
  return req.nextUrl.searchParams.get("token");
}

export function middleware(req: NextRequest) {
  if (!webUiAuthRequired()) return NextResponse.next();

  const pathname = req.nextUrl.pathname;
  if (isPublicWebUiPath(pathname)) return NextResponse.next();

  const given = tokenFromRequest(req);
  const expected = expectedWebUiToken();
  if (given && tokensMatch(given, expected)) {
    if (req.nextUrl.searchParams.get("token") === given && !pathname.startsWith("/api/")) {
      const url = req.nextUrl.clone();
      url.searchParams.delete("token");
      const res = NextResponse.redirect(url);
      res.cookies.set(WEBUI_AUTH_COOKIE, given, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
      return res;
    }
    return NextResponse.next();
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
