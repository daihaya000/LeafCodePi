import { NextRequest, NextResponse } from "next/server";
import { getTaskDetail, jsonError } from "@/lib/pi/harness";
import { imagePartDataUrl } from "@/lib/task-history";
import { InvalidTaskMessageCursorError } from "@/lib/task-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MESSAGE_ID = 512;
const MAX_PART_ID = 512;

/**
 * Serve one image part from the task transcript.
 *
 * History pages ship without base64 (the client already holds the newest page), so
 * this refetches exactly the part a user scrolls into view instead of the whole
 * page. Only images whose data URL the transcript still carries are served.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const messageId = (req.nextUrl.searchParams.get("messageId") ?? "").trim();
    const partId = (req.nextUrl.searchParams.get("partId") ?? "").trim();
    if (!messageId || !partId || messageId.length > MAX_MESSAGE_ID || partId.length > MAX_PART_ID) {
      return NextResponse.json({ error: "画像のパラメータが不正です" }, { status: 400 });
    }

    // Transcript on disk is enough; this must never block on ensureLive.
    const detail = await getTaskDetail(id, { offline: true });
    const dataUrl = imagePartDataUrl(detail.messages, { messageId, partId });
    if (!dataUrl) return NextResponse.json({ error: "画像が見つかりません" }, { status: 404 });

    const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
    if (!match) return NextResponse.json({ error: "画像形式が不正です" }, { status: 415 });
    const [, mime, base64] = match;
    if (!mime?.startsWith("image/") || !base64) {
      return NextResponse.json({ error: "画像形式が不正です" }, { status: 415 });
    }
    return new NextResponse(new Uint8Array(Buffer.from(base64, "base64")), {
      headers: {
        "content-type": mime,
        "content-disposition": "inline",
        // Private: the transcript is per-user, and the client must not pin an old clip.
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof InvalidTaskMessageCursorError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
