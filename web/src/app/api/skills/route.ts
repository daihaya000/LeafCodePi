/**
 * GET /api/skills — list Pi and bundled skills with ON/OFF state.
 */
import { NextRequest, NextResponse } from "next/server";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { listSkills, setSkillsEnabled, skillsErrorStatus, type SkillScope } from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = listSkills();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "スキル一覧の取得に失敗しました" },
      { status: skillsErrorStatus(error) },
    );
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエスト本文が不正です" }, { status: 400 });
  }
  const request = body && typeof body === "object" && !Array.isArray(body)
    ? body as { names?: unknown; enabled?: unknown; scope?: unknown }
    : null;
  const names = request?.names;
  const enabled = request?.enabled;
  const rawScope = request?.scope;
  if (!Array.isArray(names) || names.length === 0 || !names.every((name) => typeof name === "string")) {
    return NextResponse.json({ error: "names（文字列配列）が必要です" }, { status: 400 });
  }
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled（boolean）が必要です" }, { status: 400 });
  }
  if (rawScope !== undefined && rawScope !== "code" && rawScope !== "bot") {
    return NextResponse.json({ error: "scope は code または bot が必要です" }, { status: 400 });
  }
  const scope: SkillScope = rawScope === "bot" ? "bot" : "code";

  try {
    const listed = setSkillsEnabled(names, enabled, undefined, { scope });
    // Rebuilding every live session is expensive; persist and respond first.
    setImmediate(() => {
      void reloadLiveSessionsContext().catch((error) => {
        console.warn("[skills] live session context reload failed", error);
      });
    });
    return NextResponse.json({
      ok: true,
      names: [...new Set(names.map((name) => name.trim()))],
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
