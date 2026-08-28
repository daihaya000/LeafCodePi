import { NextRequest, NextResponse } from "next/server";
import { hostWebUiAuthPath, resolveHostControlUrl } from "@/lib/host-control";
import { WEBUI_AUTH_COOKIE } from "@/lib/webui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AuthPatch = { token?: string; enabled?: boolean };

async function forward(method: "GET" | "POST", body?: AuthPatch): Promise<Response> {
  const init: RequestInit = {
    method,
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return fetch(`${resolveHostControlUrl()}${hostWebUiAuthPath()}`, init);
}

async function toResponse(res: Response): Promise<NextResponse> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(data, { status: res.status });
}

export async function GET() {
  try {
    return toResponse(await forward("GET"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? `ホストに接続できません: ${err.message}` : "ホストに接続できません" },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return NextResponse.json({ error: "設定はオブジェクトである必要があります" }, { status: 400 });
  }

  const patch: AuthPatch = {};
  if (Object.prototype.hasOwnProperty.call(body, "token")) {
    if (typeof body.token !== "string") {
      return NextResponse.json({ error: "token は文字列で指定してください" }, { status: 400 });
    }
    patch.token = body.token;
  }
  if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled は boolean で指定してください" }, { status: 400 });
    }
    patch.enabled = body.enabled;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "token または enabled が必要です" }, { status: 400 });
  }

  try {
    const upstream = await forward("POST", patch);
    const response = await toResponse(upstream);
    if (upstream.ok && patch.token?.trim()) {
      response.cookies.set(WEBUI_AUTH_COOKIE, patch.token.trim(), {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? `ホストに接続できません: ${err.message}` : "ホストに接続できません" },
      { status: 502 },
    );
  }
}
