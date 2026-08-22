import { NextResponse } from "next/server";
import {
  expectedWebUiToken,
  tokensMatch,
  WEBUI_AUTH_COOKIE,
  webUiAuthRequired,
} from "@/lib/webui-auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!webUiAuthRequired()) {
    return NextResponse.json({ ok: true });
  }

  let body: { token?: unknown };
  try {
    body = (await req.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const given = String(body.token ?? "").trim();
  const expected = expectedWebUiToken();
  if (!tokensMatch(given, expected)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(WEBUI_AUTH_COOKIE, given, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
