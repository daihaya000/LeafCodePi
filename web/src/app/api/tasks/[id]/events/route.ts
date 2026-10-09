import { relayLiveEvents } from "@/lib/live-event-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) { return relayLiveEvents(request, "tasks/" + encodeURIComponent((await params).id) + "/events"); }
