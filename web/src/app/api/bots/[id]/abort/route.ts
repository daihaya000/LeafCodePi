import { NextRequest, NextResponse } from "next/server";
import { getBot, botTaskId } from "@/lib/bots";
import { abortTaskIncludingColdGoalLoop, jsonError } from "@/lib/pi/harness";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardTaskAbort } from "@/lib/backend-forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = (await params).id;
    if (!getBot(id)) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    // The Bot's session lives in the owning Backend after the cutover; the Bot-owned outbox path is the
    // same there (the forwarded botId selects it). A local abort would find nothing to stop.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskAbort(botTaskId(id), { botId: id });
      if (forwarded.ok) return NextResponse.json({ task: forwarded.task });
      if (forwarded.reason === "not-found") {
        return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
      }
      if (forwarded.reason === "not-configured") {
        return NextResponse.json({ error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" }, { status: 409 });
      }
      return NextResponse.json(
        { error: "Backendを停止できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
        { status: 502 },
      );
    }
    const task = await abortTaskIncludingColdGoalLoop(botTaskId(id));
    if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
