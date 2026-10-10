
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
  return relayJsonBusiness(request, `tasks/${encodeURIComponent((await context.params).id)}/prompt`);
}
