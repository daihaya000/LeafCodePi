import { NextRequest, NextResponse } from "next/server";
import { jsonError, setTaskAgent } from "@/lib/pi/harness";
import { forwardTaskAgent } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { agent?: unknown } | null;
    if (typeof body?.agent !== "string") {
      return NextResponse.json({ error: "agent が必要です" }, { status: 400 });
    }
    // A running session must be told by its owner; after the cutover that is the Backend.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskAgent(id, body.agent);
      if (!forwarded.ok) {
        return NextResponse.json({ error: "エージェントの変更に失敗しました" }, { status: forwarded.status ?? 502 });
      }
      return NextResponse.json({ task: forwarded.task });
    }
    return NextResponse.json({ task: await setTaskAgent(id, body.agent) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
