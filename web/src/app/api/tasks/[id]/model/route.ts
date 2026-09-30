import { NextRequest, NextResponse } from "next/server";
import { jsonError, setTaskModel } from "@/lib/pi/harness";
import { forwardTaskModel } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { model?: unknown } | null;
    if (typeof body?.model !== "string" || !body.model.trim()) {
      return NextResponse.json({ error: "model が必要です" }, { status: 400 });
    }
    // A running session must be told by its owner; after the cutover that is the Backend.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskModel(id, body.model);
      if (!forwarded.ok) {
        return NextResponse.json({ error: "モデルの変更に失敗しました" }, { status: forwarded.status ?? 502 });
      }
      return NextResponse.json({ task: forwarded.task });
    }
    return NextResponse.json({ task: await setTaskModel(id, body.model) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
