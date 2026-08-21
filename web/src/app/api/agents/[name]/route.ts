/**
 * PATCH /api/agents/:name — enable/disable a pi-subagents agent via settings.json overrides.
 */
import { NextRequest, NextResponse } from "next/server";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { agentsErrorStatus, listAgents, setAgentEnabled } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ name: string }> };

export async function PATCH(req: NextRequest, context: RouteContext) {
  const { name: rawName } = await context.params;
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
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
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled（boolean）が必要です" }, { status: 400 });
  }

  try {
    setAgentEnabled(name, enabled);
    const reload = await reloadLiveSessionsContext();
    const listed = listAgents();
    return NextResponse.json({
      ok: true,
      name,
      enabled,
      agents: listed.agents,
      reload,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "エージェントの切替に失敗しました" },
      { status: agentsErrorStatus(error) },
    );
  }
}
