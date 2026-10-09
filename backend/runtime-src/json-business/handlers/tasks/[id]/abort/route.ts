import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { botIdForCodeTask } from "@/lib/pi/bot-code-relay";
import { abortTaskIncludingColdGoalLoop, stopBotCodeTask } from "../../../../../lib/task-lifecycle";
import { jsonError } from "@/lib/pi/harness";
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  assertConfigurationOwner();
  try {
    const { id } = await params;
    // Resolve supervision in the owner, not from a caller-supplied Bot ID or Next's stale store.
    const botId = botIdForCodeTask(id);
    const task = botId ? await stopBotCodeTask(botId, id) : await abortTaskIncludingColdGoalLoop(id);
    if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}
