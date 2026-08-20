import { NextResponse } from "next/server";
import { emptyUsage } from "@/lib/sysmon";
import { collectSystemUsageCached } from "@/lib/sysmon-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sysmon/usage — host CPU / RAM / GPU snapshot.
 * Always 200; on failure returns `available: false` so the widget can hide gracefully.
 * Backed by a short in-process cache (see collectSystemUsageCached).
 */
export async function GET() {
  try {
    return NextResponse.json(await collectSystemUsageCached());
  } catch (error) {
    return NextResponse.json(
      emptyUsage(error instanceof Error ? error.message : "取得に失敗しました"),
    );
  }
}
