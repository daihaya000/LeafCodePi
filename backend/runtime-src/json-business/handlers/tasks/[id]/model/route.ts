import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { setTaskModel } from "../../../../../lib/task-execution-settings";
import { jsonError } from "@/lib/pi/harness";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  assertConfigurationOwner();
  try {
    const { id } = await params;
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!(typeof body?.model === "string" && body.model.trim())) return NextResponse.json({ error: "model が必要です" }, { status: 400 });
    const result = await setTaskModel(id, body.model as string);
    return NextResponse.json({ task: result });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
