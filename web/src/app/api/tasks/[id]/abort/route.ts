import { NextRequest, NextResponse } from "next/server";
import { botIdForCodeTask } from "@/lib/pi/bot-code-relay";
import { abortTaskIncludingColdGoalLoop, jsonError, stopBotCodeTask } from "@/lib/pi/harness";

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
