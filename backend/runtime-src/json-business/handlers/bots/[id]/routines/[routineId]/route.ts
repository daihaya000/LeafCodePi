import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getBot } from "@/lib/bots";
import { jsonError } from "@/lib/pi/harness";
import { deleteRoutine, ensureRoutineScheduler, getRoutine, patchRoutine } from "@/lib/routines";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; routineId: string }> };
export async function GET(_request: Request, { params }: Context) {
  assertConfigurationOwner();
  const { id, routineId } = await params;
  ensureRoutineScheduler();
  const routine = getRoutine(id, routineId);
  return routine ? Response.json({ routine }) : Response.json({ error: getBot(id) ? "ルーティンが見つかりません" : "ボットが見つかりません" }, { status: 404 });
}
export async function PATCH(request: Request, { params }: Context) {
  assertConfigurationOwner();
  try {
    const { id, routineId } = await params;
    ensureRoutineScheduler();
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => !["name", "prompt", "schedule", "enabled"].includes(key)) ||
        (body.name !== undefined && typeof body.name !== "string") ||
        (body.prompt !== undefined && typeof body.prompt !== "string") ||
        (body.schedule !== undefined && typeof body.schedule !== "string") ||
        (body.enabled !== undefined && typeof body.enabled !== "boolean"))
      return Response.json({ error: "ルーティン設定が不正です" }, { status: 400 });
    const routine = patchRoutine(id, routineId, body as Parameters<typeof patchRoutine>[2]);
    return routine ? Response.json({ routine }) : Response.json({ error: "ルーティンが見つかりません" }, { status: 404 });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return Response.json({ error: status >= 500 ? "Bot routineの処理結果を確認できません" : message }, { status });
  }
}
export async function DELETE(_request: Request, { params }: Context) {
  assertConfigurationOwner();
  const { id, routineId } = await params;
  ensureRoutineScheduler();
  return deleteRoutine(id, routineId) ? Response.json({ ok: true }) : Response.json({ error: "ルーティンが見つかりません" }, { status: 404 });
}
