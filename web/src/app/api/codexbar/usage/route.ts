import { NextRequest, NextResponse } from "next/server";
import { emptyUsage } from "@/lib/codexbar";
import { fetchNativeUsage } from "@/lib/codexbar/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/codexbar/usage — native provider usage (CodexBarWin-compatible shape).
 * Query: ?refresh=1 forces a fresh fetch (bypasses ~5min in-memory cache).
 * Always 200; on total failure returns `available: false`.
 */
export async function GET(req: NextRequest) {
  try {
    const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
    const usage = await fetchNativeUsage({ forceRefresh });
    return NextResponse.json(usage);
  } catch (error) {
    return NextResponse.json(
      emptyUsage(
        error instanceof Error ? error.message : "利用状況の取得に失敗しました",
      ),
    );
  }
}
