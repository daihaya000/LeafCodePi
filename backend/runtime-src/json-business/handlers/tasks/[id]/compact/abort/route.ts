import type { ConfigurationRequest } from "../../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { abortTaskCompaction } from "../../../../../../lib/task-compaction";
import { jsonError } from "../../../../../../lib/pi/harness";
export async function POST(_request: ConfigurationRequest, context: { params: Promise<{ id: string }> }) {
  assertConfigurationOwner();
  try {
    const { id } = await context.params;
    // Abort never hydrates a cold task. A provider ignoring abort may still report isCompacting.
    return Response.json({ task: await abortTaskCompaction(id) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return Response.json({ error: status >= 500 ? "タスク圧縮の処理結果を確認できません" : message }, { status });
  }
}
