import type { ConfigurationRequest } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { handoffTaskToBot, releaseTaskFromBot } from "../../../../../lib/task-supervision";
import { jsonError } from "../../../../../lib/pi/harness";
export async function POST(req: ConfigurationRequest, context: { params: Promise<{ id: string }> }) {
  assertConfigurationOwner();
  try {
    const { id } = await context.params;
    const parsed: unknown = await req.json().catch(() => null);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Response.json({ error: "リクエストボディが不正です" }, { status: 400 });
    const body = parsed as { botId?: unknown };
    if (body.botId === null) return Response.json({ task: await releaseTaskFromBot(id) });
    if (typeof body.botId !== "string" || !body.botId.trim()) return Response.json({ error: "botId が必要です" }, { status: 400 });
    const botId = body.botId.trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return Response.json({ error: "Invalid Bot ID" }, { status: 400 });
    // The owner validates Bot enabled/permissions, Code origin, existing supervisor and busy/working state.
    return Response.json({ task: await handoffTaskToBot(botId, id) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return Response.json({ error: status >= 500 ? "タスク監督の処理結果を確認できません" : message }, { status });
  }
}
