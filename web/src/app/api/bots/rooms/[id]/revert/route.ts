import { NextRequest, NextResponse } from "next/server";
import { getRoom, readRoomFile, readRoomImage } from "@/lib/rooms";
import { jsonError } from "@/lib/pi/harness";
import { revertRoomConversation } from "@/lib/room-revert";
import { forwardRoomRevert } from "@/lib/backend-forward";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import type { RoomFile, RoomImage } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rewind the shared transcript to just before a user request and hand its text back for editing.
 * Bot sessions are not rewound; the room simply stops carrying the removed turns.
 *
 * After the cutover the Backend owns the turns, the pending attention and the Code outbox, so the
 * rewind is forwarded there; the stored attachments are read here because both processes see the
 * same files.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    if (!getRoom(id)) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { messageId?: unknown } | null;
    const messageId = typeof body?.messageId === "string" ? body.messageId.trim() : "";
    if (!messageId) return NextResponse.json({ error: "messageId が指定されていません" }, { status: 400 });
    let reverted: { text: string; images: RoomImage[]; files: RoomFile[]; cancelledCodeRequests: number };
    if (localRuntimeBlocked()) {
      const forwarded = await forwardRoomRevert(id, messageId);
      if (!forwarded.ok) {
        return NextResponse.json({ error: "巻き戻しに失敗しました" }, { status: forwarded.status ?? 502 });
      }
      reverted = forwarded.result;
    } else {
      reverted = await revertRoomConversation(id, messageId);
    }
    const images = reverted.images.flatMap((image) => {
      const stored = readRoomImage(id, image.file);
      return stored
        ? [{ uri: `data:${stored.mimeType};base64,${stored.bytes.toString("base64")}`, mime: stored.mimeType }]
        : [];
    });
    const files = reverted.files.flatMap((file) => {
      const stored = readRoomFile(id, file.file);
      return stored
        ? [{ uri: `data:${file.mimeType};base64,${stored.bytes.toString("base64")}`, mime: file.mimeType, name: file.name }]
        : [];
    });
    return NextResponse.json({
      room: getRoom(id),
      text: reverted.text,
      images,
      files,
      cancelledCodeRequests: reverted.cancelledCodeRequests,
    });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
