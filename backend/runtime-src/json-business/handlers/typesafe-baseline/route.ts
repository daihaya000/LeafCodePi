import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readTypesafeSettings, mutateTypesafeSettings } from "../../../lib/typesafe-settings-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() { return Response.json(readTypesafeSettings(false)); }
export async function POST(request: Request) {
  assertConfigurationOwner();
  const result = mutateTypesafeSettings(false, "POST", await request.json().catch(() => null));
  return Response.json(result.body, { status: result.status });
}
export function DELETE() {
  const result = mutateTypesafeSettings(false, "DELETE", null);
  return Response.json(result.body, { status: result.status });
}
