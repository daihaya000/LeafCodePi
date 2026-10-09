import { NextRequest } from "next/server";
import { relayLiveEvents } from "@/lib/live-event-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return relayLiveEvents(request, `bots/rooms/${encodeURIComponent((await context.params).id)}/events`);
}
