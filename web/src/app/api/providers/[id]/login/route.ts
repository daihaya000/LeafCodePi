
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `providers/${encodeURIComponent((await context.params).id)}/login`);
}
