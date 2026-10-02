import { NextRequest, NextResponse } from "next/server";
import { revertTask, jsonError } from "@/lib/pi/harness";
import { forwardTaskRevert } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { entryId?: unknown } | null;
    const entryId = typeof body?.entryId === "string" ? body.entryId.trim() : "";
    if (!entryId) {
      return NextResponse.json({ error: "entryId が指定されていません" }, { status: 400 });
    }
    // The session tree lives in the owner: after the cutover this process must not edit it.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskRevert(id, entryId);
      if (!forwarded.ok) {
        const error = forwarded.error
          ?? (forwarded.status === 409
            ? "応答中は巻き戻せません。停止してからお試しください"
            : "巻き戻しに失敗しました");
        return NextResponse.json({ error }, { status: forwarded.status ?? 502 });
      }
      return NextResponse.json(forwarded.result);
    }
    const result = await revertTask(id, entryId);
    return NextResponse.json(result);
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
