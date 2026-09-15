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
  const sessionId = req.nextUrl.searchParams.get("sessionId")?.trim() ?? "";
  let sse: ReturnType<typeof createSseWriter> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      let unsubscribe = () => {};
      sse = createSseWriter(controller, { signal: req.signal });
      sse.onCleanup(() => unsubscribe());
      if (!sessionId) {
        sse.send("done", { type: "done", ok: false, error: "sessionId が必要です" });
        sse.close();
        return;
      }
      const active = getActiveProviderLogin();
      if (!active || active.providerId !== id || active.sessionId !== sessionId) {
        sse.send("done", { type: "done", ok: false, error: "ログインセッションがありません" });
        sse.close();
        return;
      }
      sse.send("started", {
        type: "started",
        providerId: active.providerId,
        authType: active.authType,
        sessionId: active.sessionId,
        accountId: active.accountId,
      });
      try {
        unsubscribe = subscribeProviderLogin((payload) => {
          // The route already sent a started event with the session id above.
          // ProviderLoginSession replays its history to new subscribers, so
          // forwarding its started record would duplicate that SSE event.
          if (payload.type === "started") return;
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
