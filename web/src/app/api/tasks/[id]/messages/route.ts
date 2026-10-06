import { NextRequest, NextResponse } from "next/server";
import { getTaskDetail, jsonError } from "@/lib/pi/harness";
import {
  InvalidTaskMessageCursorError,
  pageTaskMessages,
  pageTaskDetailMessages,
  stripImageDataFromMessages,
} from "@/lib/task-history";
import { readHistoryPageSize } from "@/lib/pi/history-page-size";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardTaskDetail } from "@/lib/backend-forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Older pages drop base64 image payloads: those turns were already delivered in the
 * newest page, so the client keeps its copy and refetches a single image on demand.
 * A cursorless request is the newest page, which the client has never seen, so it
 * must keep the images.
 */
function historyPage(page: ReturnType<typeof pageTaskMessages>, before: string | null) {
  return before === null ? page : { ...page, messages: stripImageDataFromMessages(page.messages) };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const before = req.nextUrl.searchParams.get("before");
    const limit = readHistoryPageSize();
    if (before !== null && (before.trim().length === 0 || before.length > 512)) {
      return NextResponse.json({ error: "履歴カーソルが不正です" }, { status: 400 });
    }
    // After the cutover the Backend owns the session; history comes from its detail, paged with the
    // same rule. There is no local fallback: a session this process does not own reports stale state.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskDetail(id, { messages: "page", limit, ...(before !== null ? { before } : {}) });
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
      return NextResponse.json(historyPage(pageTaskDetailMessages(forwarded.detail, before, limit), before));
    }
    // History paging must not block on ensureLive; transcript on disk is enough.
    const detail = await getTaskDetail(id, { offline: true });
    return NextResponse.json(historyPage(pageTaskMessages(detail.messages, before, limit), before));
  } catch (error) {
    if (error instanceof InvalidTaskMessageCursorError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
