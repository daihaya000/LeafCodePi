import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { archiveTask, destroyTask, restoreTask } from "../../../../lib/task-lifecycle";
import { jsonError } from "@/lib/pi/harness";
import { getTaskDetailBounded } from "../../../../lib/pi/get-task-detail-bounded";
import { readHistoryPageSize } from "../../../../lib/pi/history-page-size";
import { pageTaskMessages } from "@shared/task-history.mjs";
import { etagJsonResponse } from "@/lib/etag-json";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, { params }: Context) {
  assertConfigurationOwner();
  try {
    const { id } = await params;
    const messages = req.nextUrl.searchParams.get("messages");
    // Match the old Backend detail ingress: cold reads never create a live SDK session.
    const detail = await getTaskDetailBounded(id, { readOnly: true, ...(messages === "omit" ? { includeMessages: false } : {}) });
    if (messages === "page") {
      const page = pageTaskMessages(detail.messages, undefined, readHistoryPageSize());
      return etagJsonResponse(req, { task: { ...detail, ...page } });
    }
    // Archived/offline readers may include messages even when their hydration option omits them.
    return etagJsonResponse(req, { task: messages === "omit" ? { ...detail, messages: [] } : detail });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}
export async function PATCH(req: NextRequest, { params }: Context) {
  assertConfigurationOwner();
  try {
    const { id } = await params;
    const body = await req.json().catch(() => null) as { archived?: boolean } | null;
    if (body?.archived === false) return NextResponse.json({ task: restoreTask(id) });
    return NextResponse.json({ error: "unsupported patch" }, { status: 400 });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}
export async function DELETE(req: NextRequest, { params }: Context) {
  assertConfigurationOwner();
  try {
    const { id } = await params;
    return req.nextUrl.searchParams.get("hard") === "1" ? NextResponse.json(await destroyTask(id)) : NextResponse.json({ task: await archiveTask(id) });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}
