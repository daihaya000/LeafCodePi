import { ConfigurationResponse as NextResponse } from "../../../../../../configuration/http";
import { completeProviderLoginCallback, jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const raw = await req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 });
    }
    const body = raw as { sessionId?: unknown; input?: unknown };
    if (typeof body.sessionId !== "string" || !body.sessionId.trim() ||
        typeof body.input !== "string" || !body.input.trim() || body.input.length > 16384) {
      return NextResponse.json({ error: "sessionId と戻り先URLが必要です" }, { status: 400 });
    }
    await completeProviderLoginCallback(id, body.sessionId.trim(), body.input.trim());
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: "認証操作に失敗しました" }, { status });
  }
}
