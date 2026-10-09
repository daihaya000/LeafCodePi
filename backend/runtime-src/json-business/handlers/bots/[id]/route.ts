import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readBotConfiguration } from "../../../../lib/bot-lifecycle-api";
import { handleBotDelete, handleBotPatch, hasPrivilegedBotMutation } from "@/lib/bot-admin";
import { isConfigurationRequestAuthorized } from "../../../../configuration/http";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_req: Request, { params }: Context) {
  assertConfigurationOwner();
  const result = readBotConfiguration((await params).id);
  return Response.json(result.body, { status: result.status });
}
export async function PATCH(req: Request, { params }: Context) {
  assertConfigurationOwner();
  const parsed: unknown = await req.json().catch(() => null);
  if (hasPrivilegedBotMutation(parsed) && !isConfigurationRequestAuthorized(req)) return Response.json({ error: "Unauthorized" }, { status: 403 });
  const result = await handleBotPatch((await params).id, parsed);
  return Response.json(result.body, { status: result.status });
}
export async function DELETE(_req: Request, { params }: Context) {
  assertConfigurationOwner();
  const result = await handleBotDelete((await params).id);
  return Response.json(result.body, { status: result.status });
}
