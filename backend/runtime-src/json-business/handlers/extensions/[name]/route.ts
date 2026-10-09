/**
 * PATCH /api/extensions/:name — enable/disable via extensions-state.json (no folder moves).
 */
import { ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../configuration/http";
import { extensionsErrorStatus, listExtensions, setExtensionEnabled } from "@/lib/extensions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ name: string }> };

export async function PATCH(req: NextRequest, context: RouteContext) {
  const { name } = await context.params;

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
    const listed = listExtensions();
    return NextResponse.json({
      ok: true,
      name,
      enabled,
      extensions: listed.extensions,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "拡張機能の切替に失敗しました" },
      { status: extensionsErrorStatus(error) },
    );
  }
}
