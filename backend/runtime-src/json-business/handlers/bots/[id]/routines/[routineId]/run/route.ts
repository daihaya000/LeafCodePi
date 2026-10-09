import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { jsonError } from "@/lib/pi/harness";
import { ensureRoutineScheduler, getRoutine, runRoutine } from "@/lib/routines";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_request: Request, { params }: { params: Promise<{ id: string; routineId: string }> }) {
  assertConfigurationOwner();
  const { id, routineId } = await params;
  ensureRoutineScheduler();
  if (!getRoutine(id, routineId)) return Response.json({ error: "ルーティンが見つかりません" }, { status: 404 });
  try {
    // Wait for the stored prompt to finish; an HTTP body cannot replace it or grant SDK permissions.
    return Response.json({ routine: await runRoutine(id, routineId) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return Response.json({ error: status >= 500 ? "Bot routineの処理結果を確認できません" : message, routine: getRoutine(id, routineId) }, { status });
  }
}
