/**
 * PATCH /api/extensions/:name — enable/disable via extensions-state.json (no folder moves).
 */
import { NextRequest, NextResponse } from "next/server";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { extensionsErrorStatus, listExtensions, setExtensionEnabled } from "@/lib/extensions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ name: string }> };

export async function PATCH(req: NextRequest, context: RouteContext) {
  const { name: rawName } = await context.params;
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return NextResponse.json({ error: "名前が不正です" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエスト本文が不正です" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "enabled（boolean）が必要です" }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled（boolean）が必要です" }, { status: 400 });
  }

  try {
    setExtensionEnabled(name, enabled);
    const reload = await reloadLiveSessionsContext();
    const listed = listExtensions();
    return NextResponse.json({
      ok: true,
      name,
      enabled,
      extensions: listed.extensions,
      reload,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "拡張機能の切替に失敗しました" },
      { status: extensionsErrorStatus(error) },
    );
  }
}
