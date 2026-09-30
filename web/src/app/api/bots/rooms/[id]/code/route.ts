import { NextRequest, NextResponse } from "next/server";
import { getRoom } from "@/lib/rooms";
import { abortTaskIncludingColdGoalLoop, completeBotCodeRequest, jsonError } from "@/lib/pi/harness";
import { pendingRoomCodeRequestForRoom, roomCodeRequestForRoom, stopBotCodeRequest } from "@/lib/pi/bot-code-relay";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardBotCodeRequestAbort } from "@/lib/backend-forward";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stop the Room's delegated Code run. Completed work is not undone; the outbox still reports it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    if (!getRoom(id)) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { action?: unknown; requestId?: unknown } | null;
    if (body?.action !== "abort") return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    const requestedId = typeof body.requestId === "string" ? body.requestId : undefined;
    const request = requestedId ? roomCodeRequestForRoom(id, requestedId) : pendingRoomCodeRequestForRoom(id);
    if (!request) return NextResponse.json({ error: "No running Code request" }, { status: 404 });
    // The outbox belongs to the owning Backend after the cutover: the request files are shared, so the
    // lookup is local, but the stop itself must happen where the session and the outbox live.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardBotCodeRequestAbort(request.botId, request.id);
      if (forwarded.ok) {
        return NextResponse.json(
          forwarded.result.task ? { task: forwarded.result.task } : { requestId: forwarded.result.requestId, state: forwarded.result.state },
        );
      }
      if (forwarded.reason === "not-found") {
        return NextResponse.json({ error: "Code request changed" }, { status: 409 });
      }
      if (forwarded.reason === "not-configured") {
        return NextResponse.json({ error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" }, { status: 409 });
      }
      return NextResponse.json(
        { error: "Backendを停止できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
        { status: 502 },
      );
    }
    const stopped = await stopBotCodeRequest(request.botId, request.id);
    if (!stopped) return NextResponse.json({ error: "Code request changed" }, { status: 409 });
    if (stopped.codeTaskId) {
      try {
        const task = await abortTaskIncludingColdGoalLoop(stopped.codeTaskId);
        return NextResponse.json({ task });
      } finally {
        await completeBotCodeRequest(request.id);
      }
    }
    return NextResponse.json({ requestId: request.id, state: stopped.state });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
