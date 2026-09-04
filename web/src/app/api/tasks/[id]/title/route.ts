import { NextRequest, NextResponse } from "next/server";
import { parseDirectModel } from "@/lib/direct-generation";
import { refreshTaskTitleDirect } from "@/lib/direct-title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_CHARS = 8_000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  try {
    const { id } = await params;
    const result = await refreshTaskTitleDirect(id, parseDirectModel(body.model));
    return NextResponse.json(result);
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error && typeof error.status === "number"
        ? error.status
        : 502;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "タイトル生成に失敗しました" },
      { status },
    );
  }
}
