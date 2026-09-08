import { NextResponse } from "next/server";
import { activeGoalLoopTaskIds } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Host restart guard: a WebUI restart pauses every running Goal Loop. */
export async function GET() {
  const taskIds = activeGoalLoopTaskIds();
  return NextResponse.json({ active: taskIds.length, taskIds });
}
