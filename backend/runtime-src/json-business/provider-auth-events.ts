import { PROVIDER_AUTH_EVENT_LIMIT, PROVIDER_AUTH_BUFFER_LIMIT, publicProviderLoginEvent } from "@shared/provider-auth-contract.mjs";
import { configurationRequest } from "../configuration/http";
import { getActiveProviderLogin, subscribeProviderLogin } from "../lib/pi/harness";
import { createSseWriter } from "../lib/sse-writer";
import type { JsonBusinessInput } from "./index";
/** Only the runtime owner selects/replays login events. A subscriber never owns cancellation of the login. */
export function openProviderLoginEvents(input: JsonBusinessInput): Response {
  const request = configurationRequest(new Request(input.url, { headers: input.headers, signal: input.signal }), input.authorized);
  const id = input.route, sessionId = request.nextUrl.searchParams.get("sessionId")?.trim() ?? "";
  let sse: ReturnType<typeof createSseWriter> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let unsubscribe = () => {};
      sse = createSseWriter(controller, { signal: request.signal }); sse.onCleanup(() => unsubscribe());
      const send = (payload: unknown) => {
        const event = publicProviderLoginEvent(payload);
        if (!event) { sse?.close(); return; }
        const json = JSON.stringify(event), bytes = new TextEncoder().encode(json).byteLength + 32;
        if (bytes > PROVIDER_AUTH_EVENT_LIMIT || (controller.desiredSize ?? 0) < bytes) { sse?.close(); return; }
        sse?.sendSerialized(event.type as string, json);
      };
      if (sse.closed) return;
      const active = getActiveProviderLogin();
      if (!sessionId || !active || active.providerId !== id || active.sessionId !== sessionId) {
        send({ type: "done", ok: false, error: "ログインセッションがありません" }); sse.close(); return;
      }
      send({ type: "started", ...active });
      try {
        unsubscribe = subscribeProviderLogin(payload => {
          if (payload.type === "started") return;
          send(payload); if (payload.type === "done") sse?.close();
        });
      } catch { send({ type: "done", ok: false, error: "ログインイベントを購読できません" }); sse.close(); return; }
      if (sse.closed) { unsubscribe(); return; }
      sse.startHeartbeat();
    },
    cancel() { sse?.cleanup(); },
  }, { highWaterMark: PROVIDER_AUTH_BUFFER_LIMIT, size: bytes => bytes.byteLength });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-cache, no-transform" } });
}
