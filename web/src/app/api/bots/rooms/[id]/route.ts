import { NextRequest, NextResponse } from "next/server";
import { deleteRoom, getRoom, patchRoom, roomBotTaskId } from "@/lib/rooms";
import { destroyTask, resetTaskConversation } from "@/lib/pi/harness";
import { stopAllRoomCodeSessions } from "@/lib/pi/bot-code-relay";
import { cancelPendingRoomHandoffs, detachBotFromRoomRuntime, stopRoomTurns } from "@/lib/room-runtime";
import { getTask, listTasks } from "@/lib/store";
import { isWebUiRequestAuthorized } from "@/lib/webui-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function idOf(params: Promise<{ id: string }>) { return (await params).id; }
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const room = getRoom(await idOf(params));
  return room ? NextResponse.json({ room }) : NextResponse.json({ error: "\u30eb\u30fc\u30e0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => null)) as { name?: unknown; members?: unknown; botRelayEnabled?: unknown; codeAutoApprove?: unknown; resetMessages?: unknown } | null;
  if (!body || (body.name !== undefined && typeof body.name !== "string") || (body.members !== undefined && (!Array.isArray(body.members) || body.members.some((item) => typeof item !== "string"))) || (body.botRelayEnabled !== undefined && typeof body.botRelayEnabled !== "boolean") || (body.codeAutoApprove !== undefined && typeof body.codeAutoApprove !== "boolean") || (body.resetMessages !== undefined && typeof body.resetMessages !== "boolean")) return NextResponse.json({ error: "\u30eb\u30fc\u30e0\u8a2d\u5b9a\u304c\u4e0d\u6b63\u3067\u3059" }, { status: 400 });
  // Relay administration is a privileged mutation (df3dee2 bar): require Web UI token.
  if (body?.botRelayEnabled !== undefined && !isWebUiRequestAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const id = await idOf(params);
  const existing = getRoom(id);
  if (!existing) return NextResponse.json({ error: "\u30eb\u30fc\u30e0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
  if (body.resetMessages === true) {
    // Mirror 1:1 Bot reset: stop live turns, cancel Code outbox/handoffs, then wipe member sessions
    // before clearing the shared transcript so attention/Code cannot report into an empty room.
    await stopRoomTurns(id);
    cancelPendingRoomHandoffs(id);
    await stopAllRoomCodeSessions(id);
    for (const memberId of existing.members) {
      const taskId = roomBotTaskId(id, memberId);
      if (getTask(taskId)) await resetTaskConversation(taskId);
    }
  } else if (body.members !== undefined) {
    const nextMembers = body.members as string[];
    const removed = existing.members.filter((memberId) => !nextMembers.includes(memberId));
    for (const botId of removed) await detachBotFromRoomRuntime(id, botId);
  }
  const room = patchRoom(id, { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.members !== undefined ? { members: body.members as string[] } : {}), ...(body.botRelayEnabled !== undefined ? { botRelayEnabled: body.botRelayEnabled } : {}), ...(body.codeAutoApprove !== undefined ? { codeAutoApprove: body.codeAutoApprove } : {}), ...(body.resetMessages !== undefined ? { resetMessages: body.resetMessages } : {}) });
  return room ? NextResponse.json({ room }) : NextResponse.json({ error: "\u30eb\u30fc\u30e0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  if (!getRoom(id)) return NextResponse.json({ error: "\u30eb\u30fc\u30e0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
  // Same teardown as resetMessages: stop turns/handoffs/Code before destroying member tasks.
  await stopRoomTurns(id);
  cancelPendingRoomHandoffs(id);
  await stopAllRoomCodeSessions(id);
  for (const task of listTasks(true, "bot").filter((item) => item.id.endsWith(`:room:${id}`))) await destroyTask(task.id);
  return deleteRoom(id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "\u30eb\u30fc\u30e0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
}
