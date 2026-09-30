import { NextRequest, NextResponse } from "next/server";
import { botTaskId, getBot } from "@/lib/bots";
import { jsonError, revertTask } from "@/lib/pi/harness";
import { cancelBotCodeRequests } from "@/lib/pi/bot-code-relay";
import { forwardBotRevert } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

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
    // After the cutover the Backend owns the session and the outbox: rewinding here would refuse,
    // and the discarded conversation's Code jobs would keep running.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardBotRevert(id, entryId);
      if (!forwarded.ok) {
        return NextResponse.json(
          { error: "巻き戻しに失敗しました" },
          { status: forwarded.status ?? 502 },
        );
      }
      return NextResponse.json(forwarded.result);
    }
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
