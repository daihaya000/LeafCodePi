import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { clearGoalLoopAutoModel, setGoalLoopAutoModel } from "@/lib/pi/goal-loop-auto-model";
import { isGoalLoopSessionOwned, readGoalLoopState } from "@/lib/pi/goal-loop-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Marks the running Goal Loop to re-resolve the Auto model before each turn (enabled) or
 * returns it to the task's fixed model (disabled). Only a settings write: the loop's owner
 * reads the marker at its next turn, so no session is touched here.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled が必要です" }, { status: 400 });
  }
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
  if (!body.enabled) {
    clearGoalLoopAutoModel(id);
    return NextResponse.json({ enabled: false });
  }
  const loop = readGoalLoopState(task.directory, task.sessionId);
  if (!loop || !isGoalLoopSessionOwned(loop)) {
    return NextResponse.json({ error: "Goal loop が実行中ではありません" }, { status: 409 });
  }
  if (!setGoalLoopAutoModel(id, loop)) {
    return NextResponse.json({ error: "Goal loop の状態を確認できません" }, { status: 409 });
  }
  return NextResponse.json({ enabled: true });
}
