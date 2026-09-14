import { NextRequest, NextResponse } from "next/server";
import { getBot, botTaskId } from "@/lib/bots";
import { abortTaskIncludingColdGoalLoop, jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = (await params).id;
    if (!getBot(id)) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    const task = await abortTaskIncludingColdGoalLoop(botTaskId(id));
    if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
