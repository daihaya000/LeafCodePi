/**
 * GET /api/extensions — list global extensions (~/.pi/agent/extensions) with ON/OFF state.
 */
import { NextResponse } from "next/server";
import { extensionsErrorStatus, listExtensions } from "@/lib/extensions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = listExtensions();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "拡張機能一覧の取得に失敗しました" },
      { status: extensionsErrorStatus(error) },
    );
  }
}
