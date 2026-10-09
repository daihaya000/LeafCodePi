import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readRoomConfiguration } from "../../../../../lib/room-lifecycle-api";
import { handleRoomDelete, handleRoomPatch, hasPrivilegedRoomMutation, type RoomAdminBody } from "../../../../../lib/room-admin";
import { isConfigurationRequestAuthorized } from "../../../../../configuration/http";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  assertConfigurationOwner();
  const result = readRoomConfiguration((await params).id);
  return Response.json(result.body, { status: result.status });
}
export async function PATCH(request: Request, { params }: Context) {
  assertConfigurationOwner();
  const parsed = await request.json().catch(() => null);
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RoomAdminBody : null;
  if (hasPrivilegedRoomMutation(body) && !isConfigurationRequestAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 403 });
  const result = await handleRoomPatch((await params).id, body);
  return Response.json(result.body, { status: result.status });
}
export async function DELETE(_request: Request, { params }: Context) {
  assertConfigurationOwner();
  const result = await handleRoomDelete((await params).id);
  return Response.json(result.body, { status: result.status });
}
