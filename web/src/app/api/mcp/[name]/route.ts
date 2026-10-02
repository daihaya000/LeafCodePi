/**
 * PATCH /api/mcp/:name — enable/disable a global MCP server via ~/.pi/agent/mcp.json.
 */
import { NextRequest, NextResponse } from "next/server";
import { reloadLiveSessionsContext } from "@/lib/live-context";
import { listMcpServers, mcpErrorStatus, setMcpServerEnabled } from "@/lib/mcp";
import { setMcpServerEnabledOnBackend } from "@/lib/backend-client";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ name: string }> };

export async function PATCH(req: NextRequest, context: RouteContext) {
  const { name: rawName } = await context.params;
  let name: string;
  try {
    name = decodeURIComponent(rawName).trim();
  } catch {
    return NextResponse.json({ error: "名前が不正です" }, { status: 400 });
  }

  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return NextResponse.json({ error: "名前が不正です" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエスト本文が不正です" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "enabled（boolean）が必要です" }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled !== "boolean" || Object.keys(body).some((key) => key !== "enabled")) {
    return NextResponse.json({ error: "enabled（boolean）が必要です" }, { status: 400 });
  }

  try {
    if (localRuntimeBlocked()) {
      const forwarded = await setMcpServerEnabledOnBackend(name, enabled);
      if (!forwarded.ok) {
        return NextResponse.json({ error: "BackendでMCP サーバーを切替できません" }, { status: forwarded.status ?? 502 });
      }
      const result = forwarded.body;
      if (result?.ok !== true || result.name !== name || result.enabled !== enabled || !Array.isArray(result.servers)) {
        return NextResponse.json({ error: "BackendのMCP応答が不正です" }, { status: 502 });
      }
      // Only the public DTO escapes. The Backend owns both persistence and reload.
      return NextResponse.json({ ok: true, name, enabled, servers: result.servers });
    }
    setMcpServerEnabled(name, enabled);
    // Rebuilding every live session is expensive; persist and respond first.
    setImmediate(() => {
      void reloadLiveSessionsContext().catch((error) => {
        console.warn("[mcp] live session context reload failed", error);
      });
    });
    const listed = listMcpServers();
    return NextResponse.json({
      ok: true,
      name,
      enabled,
      servers: listed.servers,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MCP サーバーの切替に失敗しました" },
      { status: mcpErrorStatus(error) },
    );
  }
}
