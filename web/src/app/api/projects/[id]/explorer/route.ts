
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{id: string}> }) {
  return relayJsonBusiness(request, `projects/${encodeURIComponent((await context.params).id)}/explorer`);
}
/** Fixed ingress refusal: never relay a remote Explorer launch. */
export async function POST() {
  return Response.json({ error: "ExplorerはホストPCからのみ起動できます" }, { status: 403 });
}
