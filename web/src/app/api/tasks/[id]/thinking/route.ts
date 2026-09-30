import { NextRequest, NextResponse } from "next/server";
import { jsonError, setTaskThinkingLevel } from "@/lib/pi/harness";
import { forwardTaskThinking } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { thinkingLevel?: string } | null;
    if (!body?.thinkingLevel) {
      return NextResponse.json({ error: "thinkingLevel が必要です" }, { status: 400 });
    }
    // A running session must be told by its owner; after the cutover that is the Backend.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskThinking(id, body.thinkingLevel);
      if (!forwarded.ok) {
        return NextResponse.json({ error: "思考レベルの変更に失敗しました" }, { status: forwarded.status ?? 502 });
      }
      return NextResponse.json({ task: forwarded.task });
    }
    return NextResponse.json({ task: await setTaskThinkingLevel(id, body.thinkingLevel) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
