/**
 * PATCH /api/skills/:name — enable/disable via skills-state.json (no folder moves).
 */
import { ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../configuration/http";
import { setSkillEnabled, skillsErrorStatus, type SkillScope } from "@/lib/skills";

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
