import { NextRequest } from "next/server";
import { subscribeBotCodeSession } from "@/lib/pi/harness";
import { createSseWriter } from "@/lib/sse-writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stream Code terminal transitions for Bot surfaces that have no individual BotView mounted. */
export async function GET(req: NextRequest) {
  let sse: ReturnType<typeof createSseWriter> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const writer = createSseWriter(controller, { signal: req.signal });
      sse = writer;
      const unsubscribe = subscribeBotCodeSession((payload) => {
        if (!writer.closed) writer.send("snapshot", payload);
      });
      writer.onCleanup(unsubscribe);
      writer.startHeartbeat();
    },
    cancel() {
      sse?.cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
