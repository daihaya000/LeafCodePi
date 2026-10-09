import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getBot } from "@/lib/bots";
import { jsonError } from "@/lib/pi/harness";
import { createRoutine, ensureRoutineScheduler, listRoutines } from "@/lib/routines";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  assertConfigurationOwner();
  const { id } = await params;
  ensureRoutineScheduler();
  if (!getBot(id)) return Response.json({ error: "ボットが見つかりません" }, { status: 404 });
  return Response.json({ routines: listRoutines(id) });
}
export async function POST(request: Request, { params }: Context) {
  assertConfigurationOwner();
  try {
    const { id } = await params;
    ensureRoutineScheduler();
    if (!getBot(id)) return Response.json({ error: "ボットが見つかりません" }, { status: 404 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.name !== "string" || typeof body.prompt !== "string" || typeof body.schedule !== "string" ||
        (body.enabled !== undefined && typeof body.enabled !== "boolean"))
      return Response.json({ error: "ルーティン設定が不正です" }, { status: 400 });
    // Only authored configuration is selected. IDs, failure state and SDK privileges come from the owner.
    const routine = createRoutine(id, { name: body.name, prompt: body.prompt, schedule: body.schedule, enabled: body.enabled as boolean | undefined });
    return Response.json({ routine }, { status: 201 });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return Response.json({ error: status >= 500 ? "Bot routineの処理結果を確認できません" : message }, { status });
  }
}
