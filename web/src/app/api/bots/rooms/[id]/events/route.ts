import { NextRequest } from "next/server";
import { getRoom, subscribeRoom } from "@/lib/rooms";
import { createSseWriter } from "@/lib/sse-writer";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!getRoom(id)) return new Response("Room not found", { status: 404 });
  let sse: ReturnType<typeof createSseWriter> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = subscribeRoom(id, (room) => { if (room) sse?.send("snapshot", { type: "snapshot", room }); });
      sse = createSseWriter(controller); sse.onCleanup(unsubscribe); sse.startHeartbeat();
      const room = getRoom(id); if (room) sse.send("snapshot", { type: "snapshot", room });
      req.signal.addEventListener("abort", () => sse?.close());
    },
    cancel() { sse?.cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-cache, no-transform", Connection: "keep-alive" } });
}