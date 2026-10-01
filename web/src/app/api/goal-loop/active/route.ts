import { NextResponse } from "next/server";
import { activeGoalLoopTaskIds } from "@/lib/pi/harness";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { readBackendRuntimeState } from "@/lib/backend-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Runtime restart guard: the owner, not the client's session table, is authoritative. */
export async function GET() {
  if (localRuntimeBlocked()) {
    const result = await readBackendRuntimeState();
    if (!result.ok || !Array.isArray(result.body.taskIds) || result.body.taskIds.some((id) => typeof id !== "string")) {
      return NextResponse.json({ error: "BackendのGoal Loop状態を取得できません" }, { status: 503 });
    }
    return NextResponse.json({ active: result.body.taskIds.length, taskIds: result.body.taskIds });
  }
  const taskIds = activeGoalLoopTaskIds();
  return NextResponse.json({ active: taskIds.length, taskIds });
}
