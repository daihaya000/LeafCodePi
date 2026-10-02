/** GET lists MCP metadata; POST adds known presets in the runtime owner. */
import { NextRequest, NextResponse } from "next/server";
import { parseMcpPresetRequest, publicMcpReload } from "@shared/mcp-preset-request.mjs";
import { listMcpServers, mcpErrorStatus } from "@/lib/mcp";
import { createMcpPreset } from "@/lib/mcp-preset-admin";
import { createMcpPresetOnBackend } from "@/lib/backend-client";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

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
  const input = parseMcpPresetRequest(await req.json().catch(() => null));
  if (!input.ok) {
    return NextResponse.json({ error: "プリセットと必須項目を確認してください" }, { status: 400 });
  }
  try {
    if (localRuntimeBlocked()) {
      const forwarded = await createMcpPresetOnBackend(input.value);
      if (!forwarded.ok) {
        return NextResponse.json({ error: "BackendでMCP サーバーを追加できません" }, { status: forwarded.status ?? 502 });
      }
      const result = forwarded.body;
      const reload = publicMcpReload(result?.reload);
      if (result?.ok !== true || result.name !== input.value.preset || !Array.isArray(result.servers) || !reload) {
        return NextResponse.json({ error: "BackendのMCP応答が不正です" }, { status: 502 });
      }
      return NextResponse.json({ ok: true, name: result.name, servers: result.servers, reload });
    }
    return NextResponse.json(await createMcpPreset(input.value));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MCP サーバーの追加に失敗しました" },
      { status: mcpErrorStatus(error) },
    );
  }
}
