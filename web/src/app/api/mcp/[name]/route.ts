
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function PATCH(request: Request, context: { params: Promise<{ name: string }> }) { return relayJsonBusiness(request, `mcp/${encodeURIComponent((await context.params).name)}`); }
