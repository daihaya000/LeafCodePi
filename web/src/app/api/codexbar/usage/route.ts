import { NextRequest, NextResponse } from "next/server";
import { emptyUsage } from "@/lib/codexbar";
import { fetchNativeUsage, type UsageRequestScope } from "@/lib/codexbar/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/codexbar/usage — native provider usage (CodexBarWin-compatible shape).
 * Query: ?scope=all|account|default, ?accountId=<registered-id>, ?refresh=1.
 * Always 200 for provider errors; invalid account scope is a 4xx response.
 */
export async function GET(req: NextRequest) {
  const rawScope = req.nextUrl.searchParams.get("scope") ?? "all";
  const accountId = req.nextUrl.searchParams.get("accountId");
  let scope: UsageRequestScope;

  if (rawScope === "all" || rawScope === "default") {
    scope = { kind: rawScope };
  } else if (rawScope === "account") {
    if (!accountId?.trim()) {
      return NextResponse.json(
        { error: "scope=account では accountId が必要です" },
        { status: 400 },
      );
    }
    scope = { kind: "account", accountId: accountId.trim() };
  } else {
    return NextResponse.json(
      { error: "scope は all、account、default のいずれかです" },
      { status: 400 },
    );
  }

  try {
    const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
    const usage = await fetchNativeUsage({ forceRefresh, scope });
    return NextResponse.json(usage);
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number((error as { status?: unknown }).status)
        : 503;
    if (status === 400 || status === 404) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "リクエストが不正です" },
        { status },
      );
    }
    return NextResponse.json(
      emptyUsage(
        error instanceof Error ? error.message : "利用状況の取得に失敗しました",
      ),
    );
  }
}
