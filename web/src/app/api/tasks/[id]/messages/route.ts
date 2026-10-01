import { NextRequest, NextResponse } from "next/server";
import { getTaskDetail, jsonError } from "@/lib/pi/harness";
import {
  InvalidTaskMessageCursorError,
  pageTaskMessages,
  pageTaskDetailMessages,
} from "@/lib/task-history";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardTaskDetail } from "@/lib/backend-forward";

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
    // After the cutover the Backend owns the session; history comes from its detail, paged with the
    // same rule. There is no local fallback: a session this process does not own reports stale state.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskDetail(id, { messages: "page", ...(before !== null ? { before } : {}) });
      if (!forwarded.ok) {
        if (forwarded.reason === "invalid-cursor") {
          return NextResponse.json({ error: "履歴カーソルが無効です" }, { status: 409 });
        }
        if (forwarded.reason === "not-found") {
          return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
        }
        if (forwarded.reason === "not-configured") {
          return NextResponse.json(
            { error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" },
            { status: 409 },
          );
        }
        return NextResponse.json(
          { error: "Backendから取得できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
          { status: 502 },
        );
      }
      return NextResponse.json(pageTaskDetailMessages(forwarded.detail, before));
    }
    // History paging must not block on ensureLive; transcript on disk is enough.
    const detail = await getTaskDetail(id, { offline: true });
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
