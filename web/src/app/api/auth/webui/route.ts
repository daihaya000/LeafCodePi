import { NextResponse } from "next/server";
import {
  expectedWebUiToken,
  tokensMatch,
  WEBUI_AUTH_COOKIE,
  WEBUI_AUTH_COOKIE_OPTIONS,
  webUiAuthRequired,
} from "@/lib/webui-auth";
import {
  loginClientKey,
  loginRetryAfterSeconds,
  recordLoginFailure,
  resetLoginFailures,
} from "@/lib/webui-login-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!webUiAuthRequired()) {
    return NextResponse.json({ ok: true });
  }

  const clientKey = loginClientKey(req);
  const retryAfter = loginRetryAfterSeconds(clientKey);
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: "試行回数が多すぎます。しばらくしてから再試行してください" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
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
    recordLoginFailure(clientKey);
    return NextResponse.json({ error: "パスワードが正しくありません" }, { status: 401 });
  }

  resetLoginFailures(clientKey);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(WEBUI_AUTH_COOKIE, given, WEBUI_AUTH_COOKIE_OPTIONS);
  return res;
}
