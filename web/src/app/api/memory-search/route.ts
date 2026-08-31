import { NextRequest, NextResponse } from "next/server";
import { errorStatus } from "@/lib/agents-md";
import {
  MAX_MEMORY_SEARCH_QUERY_LENGTH,
  searchLeafCodeMemory,
} from "@/lib/memory-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { query?: unknown } | null;
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json({ error: "検索語を入力してください" }, { status: 400 });
  }
  if (query.length > MAX_MEMORY_SEARCH_QUERY_LENGTH) {
    return NextResponse.json(
      { error: `検索語は${MAX_MEMORY_SEARCH_QUERY_LENGTH}文字以内で入力してください` },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ results: searchLeafCodeMemory(query) });
  } catch (error) {
    const status = errorStatus(error);
    if (status >= 500) console.error("[memory-search] search failed", error);
    return NextResponse.json(
      { error: status < 500 && error instanceof Error ? error.message : "メモリを検索できません" },
      { status },
    );
  }
}
