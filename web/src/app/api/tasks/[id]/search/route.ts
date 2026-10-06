import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/pi/harness";
import { isHangRetryUserMessage } from "@/lib/hang-retry";
import { readTaskTranscript } from "@/lib/task-transcript";
import { MAX_SEARCH_QUERY_CHARS } from "@shared/text-search.mjs";
import { clampSearchHitLimit, searchTaskMessages } from "@shared/task-search.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A query refined while typing reuses the transcript read a moment ago instead of reading it again. */
const TRANSCRIPT_REUSE_MS = 3_000;

/**
 * Search the whole session, not just the pages the browser has loaded. The transcript is read the way
 * the history page route reads it, so a hit id is always an id the client can page to.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const query = req.nextUrl.searchParams.get("q") ?? "";
    if (query.trim().length === 0) {
      return NextResponse.json({ error: "検索語を入力してください" }, { status: 400 });
    }
    if (query.length > MAX_SEARCH_QUERY_CHARS * 2) {
      return NextResponse.json({ error: "検索語が長すぎます" }, { status: 400 });
    }
    const limit = clampSearchHitLimit(req.nextUrl.searchParams.get("limit"));
    const transcript = await readTaskTranscript(id, { maxAgeMs: TRANSCRIPT_REUSE_MS });
    if (!transcript.ok) return NextResponse.json(transcript.body, { status: transcript.status });
    return NextResponse.json(
      searchTaskMessages(transcript.messages, query, { limit, isHidden: isHangRetryUserMessage }),
    );
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
