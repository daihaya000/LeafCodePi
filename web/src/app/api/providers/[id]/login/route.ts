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
    const body = (await req.json().catch(() => ({}))) as { type?: string };
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
