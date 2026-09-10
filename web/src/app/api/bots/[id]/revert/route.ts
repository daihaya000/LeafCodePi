import { NextRequest, NextResponse } from "next/server";
import { botTaskId, getBot } from "@/lib/bots";
import { jsonError, revertTask } from "@/lib/pi/harness";
import { cancelBotCodeRequests } from "@/lib/pi/bot-code-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!getBot(id)) return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { entryId?: unknown } | null;
    const entryId = typeof body?.entryId === "string" ? body.entryId.trim() : "";
    if (!entryId) return NextResponse.json({ error: "entryId が指定されていません" }, { status: 400 });
    const result = await revertTask(botTaskId(id), entryId);
    // The discarded part of the conversation owns the outstanding Code job: stop it instead of
    // reporting a result into a request the user just reverted away (the Room path does the same).
    const cancelledCodeRequests = await cancelBotCodeRequests(id);
    return NextResponse.json({ ...result, cancelledCodeRequests });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
