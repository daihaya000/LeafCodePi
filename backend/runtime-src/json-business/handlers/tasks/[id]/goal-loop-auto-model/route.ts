import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { setTaskGoalLoopAutoModel } from "../../../../../lib/task-execution-settings";
import { jsonError } from "@/lib/pi/harness";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  assertConfigurationOwner();
  try {
    const { id } = await params;
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!(typeof body?.enabled === "boolean")) return NextResponse.json({ error: "enabled が必要です" }, { status: 400 });
    const result = await setTaskGoalLoopAutoModel(id, body.enabled as boolean);
    return NextResponse.json(result);
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
