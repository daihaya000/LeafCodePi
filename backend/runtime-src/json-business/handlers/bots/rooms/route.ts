import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createRoomConfiguration, listRoomConfiguration } from "../../../../lib/room-lifecycle-api";
import { isRoomNameWithinSize } from "../../../../lib/rooms";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET() { assertConfigurationOwner(); return Response.json(listRoomConfiguration()); }
export async function POST(request: Request) {
  assertConfigurationOwner();
  const body = await request.json().catch(() => null) as { name?: unknown; members?: unknown } | null;
  if (body?.name !== undefined && (typeof body.name !== "string" || !isRoomNameWithinSize(body.name))) return Response.json({ error: "invalid name" }, { status: 400 });
  if (body?.members !== undefined && (!Array.isArray(body.members) || body.members.some(item => typeof item !== "string"))) return Response.json({ error: "invalid members" }, { status: 400 });
  // Preserve the existing default/unknown-member filtering, selecting no caller IDs or standing permissions.
  return Response.json({ room: createRoomConfiguration({ name: body?.name as string | undefined, members: body?.members as string[] | undefined }) }, { status: 201 });
}
