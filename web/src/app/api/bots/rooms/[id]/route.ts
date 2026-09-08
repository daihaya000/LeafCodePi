import { NextRequest, NextResponse } from "next/server";
import { deleteRoom, getRoom, patchRoom } from "@/lib/rooms";
import { destroyTask } from "@/lib/pi/harness";
import { listTasks } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function idOf(params: Promise<{ id: string }>) { return (await params).id; }
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const room = getRoom(await idOf(params));
  return room ? NextResponse.json({ room }) : NextResponse.json({ error: "\u30eb\u30fc\u30e0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => null)) as { name?: unknown; members?: unknown; codeAutoApprove?: unknown; resetMessages?: unknown } | null;
  if (!body || (body.name !== undefined && typeof body.name !== "string") || (body.members !== undefined && (!Array.isArray(body.members) || body.members.some((item) => typeof item !== "string"))) || (body.codeAutoApprove !== undefined && typeof body.codeAutoApprove !== "boolean") || (body.resetMessages !== undefined && typeof body.resetMessages !== "boolean")) return NextResponse.json({ error: "\u30eb\u30fc\u30e0\u8a2d\u5b9a\u304c\u4e0d\u6b63\u3067\u3059" }, { status: 400 });
  const room = patchRoom(await idOf(params), { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.members !== undefined ? { members: body.members as string[] } : {}), ...(body.codeAutoApprove !== undefined ? { codeAutoApprove: body.codeAutoApprove } : {}), ...(body.resetMessages !== undefined ? { resetMessages: body.resetMessages } : {}) });
  return room ? NextResponse.json({ room }) : NextResponse.json({ error: "\u30eb\u30fc\u30e0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params);
  if (!getRoom(id)) return NextResponse.json({ error: "\u30eb\u30fc\u30e0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
  for (const task of listTasks(true, "bot").filter((item) => item.id.endsWith(`:room:${id}`))) await destroyTask(task.id);
  return deleteRoom(id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "\u30eb\u30fc\u30e0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093" }, { status: 404 });
}