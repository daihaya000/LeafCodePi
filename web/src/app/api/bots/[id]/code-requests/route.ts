import { NextRequest, NextResponse } from "next/server";
import { getBot } from "@/lib/bots";
import { listBotCodeRequests, stopBotCodeRequest } from "@/lib/pi/bot-code-relay";
import { abortTaskIncludingColdGoalLoop, completeBotCodeRequest, jsonError, peekCodeRequestProgress } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!getBot(id)) return NextResponse.json({ error: "ボットが見つかりません" }, { status: 404 });
  const listed = listBotCodeRequests(id);
  const requests = await Promise.all(
    listed.map(async (request) => {
      if (!request.codeTaskId) return request;
      // Skip disk/Pi peek for settled requests — outcome/goalLoop report is enough.
      if (request.state === "delivered" || request.state === "cancelled") return request;
      return { ...request, ...(await peekCodeRequestProgress(request.codeTaskId)) };
    }),
  );
  return NextResponse.json({ requests });
}

/** Stop one Code request from the Bot conversation. Finished work is not undone; the outbox still reports it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    if (!getBot(id)) return NextResponse.json({ error: "ボットが見つかりません" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { action?: unknown; requestId?: unknown } | null;
    if (body?.action !== "abort") return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    if (typeof body.requestId !== "string") return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    const stopped = await stopBotCodeRequest(id, body.requestId);
    if (!stopped) return NextResponse.json({ error: "実行中のCode依頼がありません" }, { status: 404 });
    let task: Awaited<ReturnType<typeof abortTaskIncludingColdGoalLoop>> | undefined;
    try {
      if (stopped.codeTaskId) {
        task = await abortTaskIncludingColdGoalLoop(stopped.codeTaskId);
      }
    } finally {
      if (stopped.codeTaskId) await completeBotCodeRequest(body.requestId);
    }
    return NextResponse.json({
      requestId: body.requestId,
      state: stopped.state,
      ...(task ? { task } : {}),
    });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
