/**
 * GET /api/mcp — list global MCP servers (~/.pi/agent/mcp.json) with ON/OFF state.
 * POST /api/mcp — add a known preset server (n8n / slack) to the same file.
 */
import { NextRequest, NextResponse } from "next/server";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { addN8nServer, addSlackServer, listMcpServers, mcpErrorStatus } from "@/lib/mcp";

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

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエスト本文が不正です" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "preset（n8n / slack）が必要です" }, { status: 400 });
  }
  const { preset, url, clientId } = body as { preset?: unknown; url?: unknown; clientId?: unknown };

  try {
    let name: string;
    if (preset === "n8n") {
      if (typeof url !== "string") {
        return NextResponse.json({ error: "preset（n8n）には url（string）が必要です" }, { status: 400 });
      }
      addN8nServer(url);
      name = "n8n";
    } else if (preset === "slack") {
      if (typeof clientId !== "string") {
        return NextResponse.json({ error: "preset（slack）には clientId（string）が必要です" }, { status: 400 });
      }
      addSlackServer(clientId);
      name = "slack";
    } else {
      return NextResponse.json({ error: "preset（n8n / slack）が必要です" }, { status: 400 });
    }

    const reload = await reloadLiveSessionsContext();
    const listed = listMcpServers();
    return NextResponse.json({ ok: true, name, servers: listed.servers, reload });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MCP サーバーの追加に失敗しました" },
      { status: mcpErrorStatus(error) },
    );
  }
}
