import { NextRequest, NextResponse } from "next/server";
import { jsonError, respondToPermissionPrompt } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
      requestId?: string;
      approved?: boolean;
    } | null;
    const requestId = body?.requestId?.trim();
    if (!requestId) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }
    if (typeof body?.approved !== "boolean") {
      return NextResponse.json({ error: "approved must be a boolean" }, { status: 400 });
    }
    const ok = respondToPermissionPrompt(id, requestId, body.approved);
    if (!ok) {
      return NextResponse.json({ error: "permission request not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
