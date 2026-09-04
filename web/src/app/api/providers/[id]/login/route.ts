import { NextResponse } from "next/server";
import { jsonError, startProviderLogin } from "@/lib/pi/harness";
import type { AuthTypeDto } from "@/lib/pi/auth-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const raw = await req.json().catch(() => ({}));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 });
    }
    const body = raw as { type?: unknown };
    if (body.type !== undefined && body.type !== "api_key" && body.type !== "oauth") {
      return NextResponse.json({ error: "type は oauth または api_key です" }, { status: 400 });
    }
    const authType = (body.type === "api_key" ? "api_key" : "oauth") as AuthTypeDto;
    // docs/plans/multi-account.md Phase 4。null = 既定（~/.pi/agent/auth.json）。
    const accountId = new URL(req.url).searchParams.get("accountId");
    const result = await startProviderLogin(id, authType, accountId);
    return NextResponse.json(result);
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
