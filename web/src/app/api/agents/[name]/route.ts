
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ name: string }> };

export async function GET(req: Request, context: RouteContext) {
  return relayJsonBusiness(req, `agents/${encodeURIComponent((await context.params).name)}`);
}

export async function PATCH(req: Request, context: RouteContext) {
  return relayJsonBusiness(req, `agents/${encodeURIComponent((await context.params).name)}`);
}

export async function DELETE(req: Request, context: RouteContext) {
  return relayJsonBusiness(req, `agents/${encodeURIComponent((await context.params).name)}`);
}
