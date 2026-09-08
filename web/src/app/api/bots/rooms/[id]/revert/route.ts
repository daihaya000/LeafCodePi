import { NextRequest, NextResponse } from "next/server";
import { getRoom, revertRoomTo } from "@/lib/rooms";
import { jsonError } from "@/lib/pi/harness";
import { stopRoomTurns } from "@/lib/room-runtime";
import { cancelRoomCodeRequests } from "@/lib/pi/bot-code-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rewind the shared transcript to just before a user request and hand its text back for editing.
 * Bot sessions are not rewound; the room simply stops carrying the removed turns.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    if (!getRoom(id)) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { messageId?: unknown } | null;
    const messageId = typeof body?.messageId === "string" ? body.messageId.trim() : "";
    if (!messageId) return NextResponse.json({ error: "messageId が指定されていません" }, { status: 400 });
    // Stop first: a conversation still running would append new turns into the rewound transcript.
    await stopRoomTurns(id);
    const reverted = revertRoomTo(id, messageId);
    if (!reverted) return NextResponse.json({ error: "巻き戻せるユーザー発言が見つかりません" }, { status: 404 });
    // Work started for the removed request has nowhere to report back to.
    const cancelled = cancelRoomCodeRequests(id, reverted.requestId);
    return NextResponse.json({ room: getRoom(id), text: reverted.text, cancelledCodeRequests: cancelled });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
