import { NextRequest, NextResponse } from "next/server";
import { getRoom, readRoomImage } from "@/lib/rooms";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve an attachment stored beside the room. Names are server-generated and validated on read. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  if (!getRoom(id)) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  const image = readRoomImage(id, file);
  if (!image) return NextResponse.json({ error: "画像が見つかりません" }, { status: 404 });
  return new NextResponse(new Uint8Array(image.bytes), {
    headers: { "content-type": image.mimeType, "cache-control": "private, max-age=31536000, immutable", "content-disposition": "inline" },
  });
}
