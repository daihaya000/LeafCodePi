import { NextResponse } from "next/server";
import { answerProviderLogin, cancelProviderLogin, jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const raw = await req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 });
    }
    const body = raw as { promptId?: unknown; value?: unknown; sessionId?: unknown };
    if (typeof body.promptId !== "string" || !body.promptId.trim() || typeof body.value !== "string") {
      return NextResponse.json({ error: "promptId と value が必要です" }, { status: 400 });
    }
    if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
      return NextResponse.json({ error: "sessionId が必要です" }, { status: 400 });
    }
    answerProviderLogin(body.promptId.trim(), body.value, body.sessionId.trim());
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const fromQuery = url.searchParams.get("sessionId");
    const raw = fromQuery ? null : await req.json().catch(() => null);
    const fromBody =
      raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as { sessionId?: unknown }).sessionId === "string"
        ? (raw as { sessionId: string }).sessionId
        : null;
    const sessionId = (fromQuery ?? fromBody ?? "").trim();
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId が必要です" }, { status: 400 });
    }
    cancelProviderLogin(sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
