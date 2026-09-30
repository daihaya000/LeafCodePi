import { NextRequest, NextResponse } from "next/server";
import { unrevertTask, jsonError } from "@/lib/pi/harness";
import { forwardTaskUnrevert } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // The session tree lives in the owner: after the cutover this process must not edit it.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskUnrevert(id);
      if (!forwarded.ok) {
        return NextResponse.json({ error: "巻き戻しの復元に失敗しました" }, { status: forwarded.status ?? 502 });
      }
      return NextResponse.json({ task: forwarded.task });
    }
    const task = await unrevertTask(id);
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}