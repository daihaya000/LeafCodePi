import { NextResponse } from "next/server";
import { abortTaskCompaction, jsonError } from "@/lib/pi/harness";
import { forwardTaskCompactAbort } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // Only the owner can interrupt the compaction running in its own session.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskCompactAbort(id);
      if (!forwarded.ok) {
        return NextResponse.json({ error: "圧縮の停止に失敗しました" }, { status: forwarded.status ?? 502 });
      }
      return NextResponse.json({ task: forwarded.task });
    }
    return NextResponse.json({ task: await abortTaskCompaction(id) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
