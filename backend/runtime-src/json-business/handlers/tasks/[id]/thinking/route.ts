import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { setTaskThinkingLevel } from "../../../../../lib/task-execution-settings";
import { jsonError } from "@/lib/pi/harness";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  assertConfigurationOwner();
  try {
    const { id } = await params;
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!(typeof body?.thinkingLevel === "string")) return NextResponse.json({ error: "thinkingLevel が必要です" }, { status: 400 });
    const result = await setTaskThinkingLevel(id, body.thinkingLevel as string);
    return NextResponse.json({ task: result });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
