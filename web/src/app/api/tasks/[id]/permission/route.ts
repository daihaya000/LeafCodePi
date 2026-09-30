import { NextRequest, NextResponse } from "next/server";
import { jsonError, respondToPermissionPrompt } from "@/lib/pi/harness";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardPermissionAnswer } from "@/lib/backend-forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
      requestId?: unknown;
      approved?: boolean;
    } | null;
    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }
    if (typeof body?.approved !== "boolean") {
      return NextResponse.json({ error: "approved must be a boolean" }, { status: 400 });
    }
    // After the cutover the pending request lives in the Backend, so the answer goes there. There is no
    // local fallback: answering in the wrong process would leave the real request waiting forever.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardPermissionAnswer(id, { requestId, approved: body.approved });
      if (forwarded.ok) return NextResponse.json({ ok: true });
      if (forwarded.reason === "not-found") {
        return NextResponse.json({ error: "permission request not found" }, { status: 404 });
      }
      if (forwarded.reason === "not-configured") {
        return NextResponse.json({ error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" }, { status: 409 });
      }
      return NextResponse.json(
        { error: "Backendへ回答できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
        { status: 502 },
      );
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
