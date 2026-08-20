import { NextRequest } from "next/server";
import { getActiveProviderLogin, subscribeProviderLogin } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const active = getActiveProviderLogin();
      if (!active || active.providerId !== id) {
        send("done", { type: "done", ok: false, error: "ログインセッションがありません" });
        controller.close();
        return;
      }
      send("started", {
        type: "started",
        providerId: active.providerId,
        authType: active.authType,
        sessionId: active.sessionId,
      });
      try {
        unsubscribe = subscribeProviderLogin((payload) => {
          send(payload.type, payload);
          if (payload.type === "done") {
            unsubscribe();
            if (heartbeat) clearInterval(heartbeat);
            controller.close();
          }
        });
      } catch (error) {
        send("done", {
          type: "done",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        controller.close();
        return;
      }
      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15000);
      req.signal.addEventListener("abort", () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      });
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
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
