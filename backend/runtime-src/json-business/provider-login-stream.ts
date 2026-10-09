import { PROVIDER_AUTH_EVENT_LIMIT, PROVIDER_AUTH_BUFFER_LIMIT, PROVIDER_AUTH_STREAM_LIMIT, publicProviderLoginEvent } from "@shared/provider-auth-contract.mjs";
import { serializeBoundedEvent } from "../event-stream/bounded-writer";
const GLOBAL_QUEUE_LIMIT = 16 * 1024 * 1024;
const stats = { active: 0, subscriptions: 0, queuedBytes: 0, peakQueuedBytes: 0, heartbeats: 0, stallTimers: 0, overflows: 0 };
export const readProviderLoginStreamDiagnostics = () => ({ ...stats });
import type { LoginSessionEvent } from "../lib/pi/auth-login";
type LoginSource = { active(): { providerId: string; sessionId: string; authType: string; accountId: string | null } | null; subscribe(listener: (event: LoginSessionEvent) => void): () => void };
/** A reader owns only its queue/subscription. Finite replay/done drains; overflow/abort drops it. */
export function createProviderLoginStream(signal: AbortSignal, providerId: string, sessionId: string, source: LoginSource, timing: { heartbeatMs?: number; stallMs?: number } = {}): Response {
  if (stats.active >= PROVIDER_AUTH_STREAM_LIMIT) return Response.json({ error: "Login stream capacity" }, { status: 503 });
  let pull = () => {}, cancel = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stats.active++;
      const queue: Uint8Array[] = [];
      let bytes = 0, demand = false, closed = false, ending = false, unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined, stall: ReturnType<typeof setTimeout> | undefined;
      const stopStall = () => { if (stall) { clearTimeout(stall); stall = undefined; stats.stallTimers--; } };
      const stopSource = () => {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; stats.heartbeats--; }
        if (unsubscribe) { const fn = unsubscribe; unsubscribe = undefined; stats.subscriptions--; try { fn(); } catch { /* Subscriber teardown must not retain the queue. */ } }
      };
      const close = () => {
        if (closed) return; closed = true; stopStall(); stopSource();
        stats.queuedBytes -= bytes; bytes = 0; queue.length = 0; stats.active--;
        signal.removeEventListener("abort", close);
        try { controller.close(); } catch { /* Already canceled. */ }
      };
      const arm = () => { stopStall(); if (queue.length) { stats.stallTimers++; stall = setTimeout(close, timing.stallMs ?? 45000); stall.unref?.(); } };
      const pump = () => {
        if (closed) return;
        if (demand && queue.length) {
          const frame = queue.shift()!; bytes -= frame.length; stats.queuedBytes -= frame.length; demand = false;
          try { controller.enqueue(frame); } catch { close(); return; }
          arm();
        }
        if (ending && !queue.length) close();
      };
      const finish = () => { ending = true; stopSource(); pump(); };
      const enqueue = (frame: Uint8Array) => {
        if (closed || ending) return;
        if (frame.length > PROVIDER_AUTH_EVENT_LIMIT || bytes + frame.length > PROVIDER_AUTH_BUFFER_LIMIT || stats.queuedBytes + frame.length > GLOBAL_QUEUE_LIMIT) { stats.overflows++; close(); return; }
        queue.push(frame); bytes += frame.length; stats.queuedBytes += frame.length; stats.peakQueuedBytes = Math.max(stats.peakQueuedBytes, stats.queuedBytes);
        if (!stall) arm(); pump();
      };
      const send = (payload: unknown) => {
        if (closed || ending) return;
        try {
          const event = publicProviderLoginEvent(payload); if (!event) { close(); return; }
          const json = serializeBoundedEvent(event, PROVIDER_AUTH_EVENT_LIMIT - 32);
          enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${json}\n\n`));
        } catch { stats.overflows++; close(); }
      };
      pull = () => { demand = true; pump(); }; cancel = close;
      signal.addEventListener("abort", close, { once: true }); if (signal.aborted) { close(); return; }
      let active: ReturnType<LoginSource["active"]>;
      try { active = source.active(); } catch { send({ type: "done", ok: false }); finish(); return; }
      if (!sessionId || !active || active.providerId !== providerId || active.sessionId !== sessionId) { send({ type: "done", ok: false }); finish(); return; }
      send({ type: "started", ...active }); if (closed) return;
      try {
        const off = source.subscribe(event => { if (event.type === "started") return; send(event); if (event.type === "done") finish(); });
        if (closed || ending) off(); else { unsubscribe = off; stats.subscriptions++; }
      } catch { send({ type: "done", ok: false }); finish(); return; }
      if (closed || ending) return;
      stats.heartbeats++; heartbeat = setInterval(() => enqueue(new TextEncoder().encode(": ping\n\n")), timing.heartbeatMs ?? 15000); heartbeat.unref?.();
    },
    pull() { pull(); }, cancel() { cancel(); },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "private, no-store, no-cache, no-transform", "x-content-type-options": "nosniff" } });
}
