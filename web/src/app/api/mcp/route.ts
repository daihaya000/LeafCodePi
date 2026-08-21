/**
 * GET /api/mcp — list global MCP servers (~/.pi/agent/mcp.json) with ON/OFF state.
 */
import { NextResponse } from "next/server";
import { listMcpServers, mcpErrorStatus } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(listMcpServers());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MCP サーバー一覧の取得に失敗しました" },
      { status: mcpErrorStatus(error) },
    );
  }
}
