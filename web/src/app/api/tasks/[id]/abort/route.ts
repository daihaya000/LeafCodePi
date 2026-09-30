import { NextRequest, NextResponse } from "next/server";
import { botIdForCodeTask } from "@/lib/pi/bot-code-relay";
import { abortTaskIncludingColdGoalLoop, jsonError, stopBotCodeTask } from "@/lib/pi/harness";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardTaskAbort } from "@/lib/backend-forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // Bot-owned / supervised Code must mark the outbox stoppedByUser (same as Bot panel abort).
    const botId = botIdForCodeTask(id);
    // After the cutover the session lives in the Backend: a local abort would find nothing to stop, and
    // the real session would keep running.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskAbort(id, botId ? { botId } : {});
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
    if (botId) {
      return NextResponse.json({ task: await stopBotCodeTask(botId, id) });
    }
    const task = await abortTaskIncludingColdGoalLoop(id);
    if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
