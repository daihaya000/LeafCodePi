import { NextRequest, NextResponse } from "next/server";
import { getRoom, readRoomFile } from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve a text attachment stored beside the room. The filename is server-generated. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; file: string }> },
) {
  const { id, file } = await params;
  const room = getRoom(id);
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  const metadata = room.messages
    .flatMap((message) => message.files ?? [])
    .find((item) => item.file === file);
  const stored = metadata ? readRoomFile(id, file) : undefined;
  if (!metadata || !stored) return NextResponse.json({ error: "ファイルが見つかりません" }, { status: 404 });
  const encodedName = encodeURIComponent(metadata.name).replace(/'/g, "%27");
  return new NextResponse(new Uint8Array(stored.bytes), {
    headers: {
      "content-type": metadata.mimeType,
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": `attachment; filename*=UTF-8''${encodedName}`,
      "x-content-type-options": "nosniff",
    },
  });
}
