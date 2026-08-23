import { NextRequest } from "next/server";
import { getActiveProviderLogin, subscribeProviderLogin } from "@/lib/pi/harness";
import { createSseWriter } from "@/lib/sse-writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let sse: ReturnType<typeof createSseWriter> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      let unsubscribe = () => {};
      sse = createSseWriter(controller);
      sse.onCleanup(() => unsubscribe());
      const active = getActiveProviderLogin();
      if (!active || active.providerId !== id) {
        sse.send("done", { type: "done", ok: false, error: "ログインセッションがありません" });
        sse.close();
        return;
      }
      sse.send("started", {
        type: "started",
        providerId: active.providerId,
        authType: active.authType,
        sessionId: active.sessionId,
      });
      try {
        unsubscribe = subscribeProviderLogin((payload) => {
          sse?.send(payload.type, payload);
          if (payload.type === "done") sse?.close();
        });
      } catch (error) {
        sse.send("done", {
          type: "done",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        sse.close();
        return;
      }
      if (sse.closed) {
        unsubscribe();
        return;
      }
      sse.startHeartbeat();
      req.signal.addEventListener("abort", () => sse?.close());
    },
    cancel() {
      sse?.cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
