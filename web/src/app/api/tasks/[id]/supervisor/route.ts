import { NextRequest, NextResponse } from "next/server";
import { handoffTaskToBot, jsonError, releaseTaskFromBot } from "@/lib/pi/harness";
import { forwardTaskAdmin } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { botId?: unknown } | null;
    const release = body?.botId === null;
    if (!release && (typeof body?.botId !== "string" || !body.botId.trim())) {
      return NextResponse.json({ error: "botId が必要です" }, { status: 400 });
    }
    // The session is rewired where it lives: the owning Backend answers and its answer is replayed.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskAdmin(
        id,
        release ? { action: "release" } : { action: "handoff", botId: body?.botId as string },
      );
      if (!forwarded.ok) {
        return NextResponse.json(
          { error: "Backendで実行できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
          { status: 502 },
        );
      }
      return NextResponse.json(forwarded.body, { status: forwarded.status });
    }
    if (release) return NextResponse.json({ task: await releaseTaskFromBot(id) });
    return NextResponse.json({ task: await handoffTaskToBot(body?.botId as string, id) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
