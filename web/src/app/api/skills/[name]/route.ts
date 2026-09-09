/**
 * PATCH /api/skills/:name — enable/disable via skills-state.json (no folder moves).
 */
import { NextRequest, NextResponse } from "next/server";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { setSkillEnabled, skillsErrorStatus, type SkillScope } from "@/lib/skills";

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
  const request = body && typeof body === "object" && !Array.isArray(body)
    ? body as { enabled?: unknown; scope?: unknown }
    : null;
  const enabled = request?.enabled;
  const rawScope = request?.scope;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled（boolean）が必要です" }, { status: 400 });
  }
  if (rawScope !== undefined && rawScope !== "code" && rawScope !== "bot") {
    return NextResponse.json({ error: "scope は code または bot が必要です" }, { status: 400 });
  }
  const scope: SkillScope = rawScope === "bot" ? "bot" : "code";

  try {
    const listed = setSkillEnabled(name, enabled, undefined, { scope });
    // Rebuilding every live session is expensive; persist and respond first.
    setImmediate(() => {
      void reloadLiveSessionsContext().catch((error) => {
        console.warn("[skills] live session context reload failed", error);
      });
    });
    return NextResponse.json({
      ok: true,
      name,
      enabled,
      scope,
      skills: listed.skills,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "スキルの切替に失敗しました" },
      { status: skillsErrorStatus(error) },
    );
  }
}
