import { NextResponse } from "next/server";
import { errorStatus, readGlobalBotsMd, writeGlobalBotsMd } from "@/lib/agents-md";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(readGlobalBotsMd());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "BOTS.mdの読み込みに失敗しました" },
      { status: errorStatus(error) },
    );
  }
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエスト本文が不正です" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "content は文字列で指定してください" }, { status: 400 });
  }
  const content = (body as { content?: unknown }).content;
  if (typeof content !== "string") {
    return NextResponse.json({ error: "content は文字列で指定してください" }, { status: 400 });
  }

  try {
    const saved = writeGlobalBotsMd(content);
    // Bot sessions append BOTS.md by path, so a reload re-reads it in place.
    const reload = await reloadLiveSessionsContext();
    return NextResponse.json({ ok: true, ...saved, reload });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "BOTS.mdの保存に失敗しました" },
      { status: errorStatus(error) },
    );
  }
}
