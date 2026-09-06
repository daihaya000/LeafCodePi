import { NextRequest, NextResponse } from "next/server";
import { deleteRoom, getRoom, patchRoom } from "@/lib/rooms";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function idOf(params: Promise<{ id: string }>) { return (await params).id; }
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const room = getRoom(await idOf(params));
  return room ? NextResponse.json({ room }) : NextResponse.json({ error: "Room not found" }, { status: 404 });
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => null)) as { name?: unknown; members?: unknown } | null;
  if (!body || (body.name !== undefined && typeof body.name !== "string") || (body.members !== undefined && (!Array.isArray(body.members) || body.members.some((item) => typeof item !== "string")))) return NextResponse.json({ error: "invalid room patch" }, { status: 400 });
  const room = patchRoom(await idOf(params), { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.members !== undefined ? { members: body.members as string[] } : {}) });
  return room ? NextResponse.json({ room }) : NextResponse.json({ error: "Room not found" }, { status: 404 });
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return deleteRoom(await idOf(params)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Room not found" }, { status: 404 });
}