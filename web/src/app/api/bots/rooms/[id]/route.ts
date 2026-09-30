import { NextRequest, NextResponse } from "next/server";
import { getRoom } from "@/lib/rooms";
import { hasPrivilegedRoomMutation, handleRoomDelete, handleRoomPatch, type RoomAdminBody } from "@/lib/room-admin";
import { forwardRoomAdmin } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { isWebUiRequestAuthorized } from "@/lib/webui-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function idOf(params: Promise<{ id: string }>) { return (await params).id; }

/**
 * Room settings and deletion.
 *
 * The teardown (stopping turns, resetting member sessions, detaching a Bot, destroying member tasks)
 * lives in `handleRoomPatch`/`handleRoomDelete`, because only the runtime owner may do it: after the
 * cutover this route forwards the same body to the Backend and replays its answer unchanged. The
 * WebUI token check stays here, before the forward.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const room = getRoom(await idOf(params));
  return room ? NextResponse.json({ room }) : NextResponse.json({ error: "ルームが見つかりません" }, { status: 404 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  const parsed: unknown = await req.json().catch(() => null);
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RoomAdminBody : null;
  // Relay / standing Code approval are privileged mutations: require Web UI token.
  if (hasPrivilegedRoomMutation(body) && !isWebUiRequestAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  if (localRuntimeBlocked()) {
    const forwarded = await forwardRoomAdmin("PATCH", id, body);
    if (!forwarded.ok) {
      return NextResponse.json(
        { error: "Backendへ転送できません", reason: forwarded.reason },
        { status: forwarded.status ?? 502 },
      );
    }
    return NextResponse.json(forwarded.result.body, { status: forwarded.result.status });
  }
  const result = await handleRoomPatch(id, body);
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  if (localRuntimeBlocked()) {
    const forwarded = await forwardRoomAdmin("DELETE", id, null);
    if (!forwarded.ok) {
      return NextResponse.json(
        { error: "Backendへ転送できません", reason: forwarded.reason },
        { status: forwarded.status ?? 502 },
      );
    }
    return NextResponse.json(forwarded.result.body, { status: forwarded.result.status });
  }
  const result = await handleRoomDelete(id);
  return NextResponse.json(result.body, { status: result.status });
}
