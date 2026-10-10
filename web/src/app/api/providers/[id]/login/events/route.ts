
import { relayProviderLoginEvents } from "@/lib/provider-auth-events-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return relayProviderLoginEvents(req, encodeURIComponent((await context.params).id));
}
