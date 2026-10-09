import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getUnreadReadMarkers, markUnreadRead } from "../../../lib/unread-state";
export function GET() { assertConfigurationOwner(); return Response.json({ markers: getUnreadReadMarkers() }); }
export async function PUT(request: Request) {
  assertConfigurationOwner();
  const body = await request.json().catch(() => null);
  const readAt = markUnreadRead(body?.kind, body?.id, body?.readAt);
  return readAt === null ? Response.json({ error: "invalid unread marker" }, { status: 400 }) : Response.json({ readAt });
}
