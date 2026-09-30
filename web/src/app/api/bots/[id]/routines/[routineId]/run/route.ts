import { NextRequest, NextResponse } from "next/server";
import { ensureRoutineScheduler, getRoutine, runRoutine } from "@/lib/routines";
import { forwardBotRoutineRun } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; routineId: string }> },
) {
  const { id, routineId } = await params;
  // After the cutover the Backend owns the scheduler and the run: starting either here would
  // duplicate the schedule and refuse the prompt.
  const backendOwns = localRuntimeBlocked();
  if (!backendOwns) ensureRoutineScheduler();
  if (!getRoutine(id, routineId)) {
    return NextResponse.json({ error: "ルーティンが見つかりません" }, { status: 404 });
  }
  if (backendOwns) {
    const forwarded = await forwardBotRoutineRun(id, routineId);
    if (!forwarded.ok) {
      return NextResponse.json(
        { error: "ルーティンの実行に失敗しました", routine: getRoutine(id, routineId) },
        { status: forwarded.status ?? 502 },
      );
    }
    return NextResponse.json({ routine: forwarded.routine ?? getRoutine(id, routineId) });
  }
  try {
    return NextResponse.json({ routine: await runRoutine(id, routineId) });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "ルーティンの実行に失敗しました",
        routine: getRoutine(id, routineId),
      },
      { status: 500 },
    );
  }
}
