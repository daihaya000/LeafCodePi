import { NextRequest, NextResponse } from "next/server";
import { getTaskDetail, jsonError } from "@/lib/pi/harness";
import {
  InvalidTaskMessageCursorError,
  pageTaskMessages,
} from "@/lib/task-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const before = req.nextUrl.searchParams.get("before");
    if (before !== null && (before.trim().length === 0 || before.length > 512)) {
      return NextResponse.json({ error: "履歴カーソルが不正です" }, { status: 400 });
    }
    const detail = await getTaskDetail(id);
    const page = pageTaskMessages(detail.messages, before);
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof InvalidTaskMessageCursorError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
