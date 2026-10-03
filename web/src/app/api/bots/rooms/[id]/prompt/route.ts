import { NextRequest, NextResponse } from "next/server";
import { handleRoomPrompt, type RoomPromptBody } from "@/lib/room-prompt";
import { forwardRoomPrompt } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Post a user turn into a Room.
 *
 * The routing ladder (validation, stop requests, relay envelopes, steering, session starts) lives in
 * `handleRoomPrompt`, because the owner must run it: after the cutover this route forwards the same
 * body to the Backend and replays the owner's answer unchanged.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const parsed: unknown = await req.json().catch(() => null);
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RoomPromptBody : null;
  if (localRuntimeBlocked()) {
    const forwarded = await forwardRoomPrompt(id, body);
    if (!forwarded.ok) {
      return NextResponse.json(
        { error: "Backendへ転送できません", reason: forwarded.reason },
        { status: forwarded.status ?? 502 },
      );
    }
    return NextResponse.json(forwarded.result.body, { status: forwarded.result.status });
  }
  const result = await handleRoomPrompt(id, body, { signal: req.signal });
  return NextResponse.json(result.body, { status: result.status });
}
