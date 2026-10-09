import type { ConfigurationRequest } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { compactTask } from "../../../../../lib/task-compaction";
import { isPromptTextWithinSize } from "../../../../../lib/prompt-images";
import { jsonError } from "../../../../../lib/pi/harness";
export async function POST(request: ConfigurationRequest, context: { params: Promise<{ id: string }> }) {
  assertConfigurationOwner();
  try {
    const { id } = await context.params;
    const parsed: unknown = await request.json().catch(() => null);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Response.json({ error: "リクエストボディが不正です" }, { status: 400 });
    const body = parsed as { customInstructions?: unknown };
    if (body.customInstructions !== undefined && typeof body.customInstructions !== "string") return Response.json({ error: "customInstructions must be a string" }, { status: 400 });
    if (typeof body.customInstructions === "string" && !isPromptTextWithinSize(body.customInstructions)) return Response.json({ error: "本文プロンプトが長すぎます" }, { status: 413 });
    // Only authored focus is forwarded. Model/account/Agent/Goal/privilege selection remains SDK-owned.
    return Response.json({ task: await compactTask(id, body.customInstructions as string | undefined) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return Response.json({ error: status >= 500 ? "タスク圧縮の処理結果を確認できません" : message }, { status });
  }
}
