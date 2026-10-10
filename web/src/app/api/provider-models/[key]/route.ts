
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, context: { params: Promise<{ key: string }> }) {
  return relayJsonBusiness(req, `provider-models/${encodeURIComponent((await context.params).key)}`);
}
