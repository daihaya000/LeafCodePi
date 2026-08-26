import { NextResponse } from "next/server";
import { jsonError, logoutProvider } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // docs/plans/multi-account.md Phase 4。null = 既定（~/.pi/agent/auth.json）。
    const accountId = new URL(req.url).searchParams.get("accountId");
    await logoutProvider(id, accountId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
