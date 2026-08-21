/**
 * GET /api/agents — list pi-subagents agents (builtin + user) with ON/OFF state.
 */
import { NextResponse } from "next/server";
import { agentsErrorStatus, listAgents } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(listAgents());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "エージェント一覧の取得に失敗しました" },
      { status: agentsErrorStatus(error) },
    );
  }
}
