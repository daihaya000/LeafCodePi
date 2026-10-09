import { NextRequest } from "next/server";
import { relayLiveEvents } from "@/lib/live-event-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  return relayLiveEvents(request, "bots/events");
}
