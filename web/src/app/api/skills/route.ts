/**
 * GET /api/skills — list global Pi skills (~/.pi/agent/skills) with ON/OFF state.
 */
import { NextResponse } from "next/server";
import { listSkills, skillsErrorStatus } from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = listSkills();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "スキル一覧の取得に失敗しました" },
      { status: skillsErrorStatus(error) },
    );
  }
}
