import { NextRequest, NextResponse } from "next/server";
import { getRoom } from "@/lib/rooms";
import { abortTask, jsonError } from "@/lib/pi/harness";
import { pendingRoomCodeRequestForRoom, roomCodeRequestForRoom, stopBotCodeRequest } from "@/lib/pi/bot-code-relay";
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
    const stopped = await stopBotCodeRequest(request.botId, request.id);
    if (!stopped) return NextResponse.json({ error: "Code request changed" }, { status: 409 });
    return NextResponse.json(stopped.codeTaskId
      ? { task: await abortTask(stopped.codeTaskId) }
      : { requestId: request.id, state: stopped.state });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
