
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `accounts/${encodeURIComponent((await context.params).id)}/auth-status`);
}
