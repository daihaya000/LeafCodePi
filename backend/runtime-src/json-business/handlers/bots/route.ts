import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readBotCollection, createBotConfiguration } from "../../../lib/bot-lifecycle-api";
import { etagJsonResponse } from "@/lib/etag-json";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(req?: Request) { assertConfigurationOwner(); return etagJsonResponse(req, readBotCollection()); }
export async function POST(req: Request) {
  assertConfigurationOwner();
  const result = createBotConfiguration(await req.json().catch(() => null));
  return Response.json(result.body, { status: result.status });
}
