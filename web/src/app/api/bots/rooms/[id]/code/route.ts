import { NextRequest, NextResponse } from "next/server";
import { getRoom } from "@/lib/rooms";
import { abortTask, jsonError } from "@/lib/pi/harness";
import { pendingRoomCodeRequestForRoom } from "@/lib/pi/bot-code-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stop the Room's delegated Code run. Completed work is not undone; the outbox still reports it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    if (!getRoom(id)) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
    if (body?.action !== "abort") return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    const request = pendingRoomCodeRequestForRoom(id);
    if (!request?.codeTaskId) return NextResponse.json({ error: "No running Code request" }, { status: 404 });
    return NextResponse.json({ task: await abortTask(request.codeTaskId) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
