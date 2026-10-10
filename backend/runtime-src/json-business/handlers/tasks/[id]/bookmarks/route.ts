import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { isCrossOriginRequest } from "@/lib/same-origin";
import { getTask } from "@/lib/store";
import { isBookmarkTaskId, storedTaskIds, taskBookmarks } from "@/lib/task-bookmarks";
import { readTaskTranscript } from "@/lib/task-transcript";
import { readSessionHistoryMessageIds } from "@/lib/session-history-page";

import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_CHARS = 4_000;

function taskExists(id: string): boolean {
  return isBookmarkTaskId(id) && Boolean(getTask(id));
}

function notFound() {
  return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
}

/** Store errors carry a client-safe message and status; anything else must not leak paths. */
function failure(error: unknown) {
  const status =
    typeof error === "object" && error && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
  const message =
    status < 500 && error instanceof Error ? error.message : "ブックマークを保存できませんでした";
  return NextResponse.json({ error: message }, { status });
}

/**
 * `?verify=1` also reports `missing`: bookmarked messages the session no longer contains (rewound or
 * deleted), found with one transcript read. Verification is best effort; when the transcript cannot be
 * read, `missing` is left out and the client treats every bookmark as unverified.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  assertConfigurationOwner();
  const { id } = await params;
  if (!taskExists(id)) return notFound();
  const bookmarks = taskBookmarks.list(id);
  if (req.nextUrl.searchParams.get("verify") !== "1" || bookmarks.length === 0) {
    return NextResponse.json({ bookmarks });
  }
  try {
    const file = getTask(id)?.sessionFile;
    let present: Set<string>;
    if (file) {
      present = await readSessionHistoryMessageIds(file, bookmarks.map((bookmark) => bookmark.messageId));
    } else {
      const transcript = await readTaskTranscript(id);
      if (!transcript.ok) return NextResponse.json({ bookmarks });
      present = new Set(transcript.messages.map((message) => message.id));
    }
    return NextResponse.json({
      bookmarks,
      missing: bookmarks.filter((bookmark) => !present.has(bookmark.messageId)).map((bookmark) => bookmark.messageId),
    });
  } catch {
    return NextResponse.json({ bookmarks });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  assertConfigurationOwner();
  if (isCrossOriginRequest(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_REQUEST_CHARS) {
    return NextResponse.json({ error: "request body is too large" }, { status: 413 });
  }
  const body = (() => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  })();
  if (!body) {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 });
  }
  const { id } = await params;
  if (!taskExists(id)) return notFound();
  try {
    const bookmarks = taskBookmarks.add(
      id,
      {
        messageId: body.messageId as string,
        role: body.role as "user" | "assistant",
        messageCreatedAt: body.messageCreatedAt as number | undefined,
        preview: body.preview as string | undefined,
      },
      { knownTaskIds: storedTaskIds() },
    );
    return NextResponse.json({ bookmarks });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  assertConfigurationOwner();
  if (isCrossOriginRequest(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const messageId = req.nextUrl.searchParams.get("messageId");
  if (!messageId || messageId.length > 256) {
    return NextResponse.json({ error: "messageId が必要です" }, { status: 400 });
  }
  const { id } = await params;
  if (!taskExists(id)) return notFound();
  try {
    return NextResponse.json({ bookmarks: taskBookmarks.remove(id, messageId) });
  } catch (error) {
    return failure(error);
  }
}
