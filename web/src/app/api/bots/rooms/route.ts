import { NextRequest, NextResponse } from "next/server";
import { createRoom, listRooms } from "@/lib/rooms";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { return NextResponse.json({ rooms: listRooms() }); }
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { name?: unknown; members?: unknown } | null;
  if (body?.name !== undefined && typeof body.name !== "string") return NextResponse.json({ error: "invalid name" }, { status: 400 });
  if (body?.members !== undefined && (!Array.isArray(body.members) || body.members.some((item) => typeof item !== "string"))) return NextResponse.json({ error: "invalid members" }, { status: 400 });
  return NextResponse.json({ room: createRoom({ name: body?.name as string | undefined, members: body?.members as string[] | undefined }) }, { status: 201 });
}