
import { relayLiveEvents } from "@/lib/live-event-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return relayLiveEvents(request, `bots/rooms/${encodeURIComponent((await context.params).id)}/events`);
}
