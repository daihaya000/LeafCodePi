import { NextRequest, NextResponse } from "next/server";
import { parseDirectModel } from "@/lib/direct-generation";
import { refreshTaskTitleDirect } from "@/lib/direct-title";
import { patchTask } from "@/lib/store";
import { sanitizeTitle } from "@/lib/direct-generation-text";

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

export async function PATCH(
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

  const rawTitle = body.title;
  const rawAutoUpdate = body.titleAutoUpdate;
  if (rawTitle === undefined && rawAutoUpdate === undefined) {
    return NextResponse.json({ error: "title または titleAutoUpdate が必要です" }, { status: 400 });
  }
  if (rawTitle !== undefined && typeof rawTitle !== "string") {
    return NextResponse.json({ error: "invalid title" }, { status: 400 });
  }
  if (rawAutoUpdate !== undefined && typeof rawAutoUpdate !== "boolean") {
    return NextResponse.json({ error: "invalid titleAutoUpdate" }, { status: 400 });
  }

  const patch: Parameters<typeof patchTask>[1] = {};
  if (typeof rawTitle === "string") {
    const title = sanitizeTitle(rawTitle);
    if (!title) {
      return NextResponse.json({ error: "タイトルを入力してください" }, { status: 400 });
    }
    patch.title = title;
    // A manual title is opt-out by default; users can explicitly turn auto
    // updates back on in the same request or via the switch.
    patch.titleAutoUpdate = rawAutoUpdate === undefined ? false : rawAutoUpdate;
  } else if (typeof rawAutoUpdate === "boolean") {
    patch.titleAutoUpdate = rawAutoUpdate;
  }

  const { id } = await params;
  const task = patchTask(id, patch);
  if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
  return NextResponse.json({ title: task.title, task });
}
