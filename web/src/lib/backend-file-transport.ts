import { Client, type Dispatcher } from "@/lib/gateway-http.mjs";
/** Private Backend IO only. Raw dispatch avoids fetch copies AND Readable iterator
 * concatenation. One parser chunk per demand; the relay owns auth/deadlines/abort.
 */
export async function openBackendFileSource(url: string, init: RequestInit): Promise<Response> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || init.signal?.aborted) throw new Error('Backend source unavailable');
  const body = init.body;
  if (body != null && !(body instanceof ArrayBuffer)) throw new Error('Invalid Backend input');
  // Keep the peer alive until consumed: Undici's FIN handler drains paused
  // parsers, bypassing demand. This single-use client is destroyed at EOF/cancel.
  const client = new Client(target.origin, { pipelining: 1, allowH2: false, maxCachedSessions: 0, bodyTimeout: 0, headersTimeout: 0, connectTimeout: 10_000 });
  return new Promise<Response>((resolve, reject) => {
    let output: ReadableStreamDefaultController<Uint8Array> | undefined, control: Dispatcher.DispatchController | undefined;
    let stopped = false, ended = false, held: Buffer | undefined, offset = 0, closing: Promise<void> | undefined;
    const abort = () => fail(new Error('Backend source aborted'));
    const close = () => {
      if (closing) return closing;
      stopped = true; held = undefined; init.signal?.removeEventListener('abort', abort);
      return closing = client.destroy();
    };
    const finish = () => { if (!held && ended && !stopped) void close().then(() => { try { output?.close(); } catch { /* canceled */ } }); };
    const emit = () => {
      if (!held || stopped) return;
      const chunk = held, end = Math.min(offset + 65536, chunk.byteLength);
      const view = chunk.subarray(offset, end); offset = end;
      if (offset === chunk.byteLength) held = undefined;
      output!.enqueue(view); finish();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      reject(error); try { output?.error(new Error('Backend source closed', { cause: error })); } catch { /* canceled */ }
      void close();
    };
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) { abort(); return; }
    try {
      client.dispatch({ path: target.pathname + target.search, method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers)), body: body instanceof ArrayBuffer ? Buffer.from(body) : undefined,
      }, {
        onRequestStart(controller) { control = controller; if (stopped) controller.abort(new Error('Backend source closed')); },
        onRequestUpgrade(_controller, _status, _headers, socket) { socket.destroy(); fail(new Error('Backend upgrade rejected')); },
        onResponseStart(controller, status, values) {
          if (status < 200 || stopped) return;
          controller.pause();
          const headers = new Headers();
          for (const [name, value] of Object.entries(values)) if (value !== undefined) for (const part of Array.isArray(value) ? value : [value]) headers.append(name, part);
          if (init.method === 'HEAD' || [204, 205, 304].includes(status)) {
            void close().then(() => resolve(new Response(null, { status, headers })), reject); return;
          }
          const stream = new ReadableStream<Uint8Array>({
            start(controller) { output = controller; },
            pull() { if (!stopped) { if (held) emit(); else if (ended) finish(); else control?.resume(); } },
            async cancel() { await close(); },
          }, { highWaterMark: 0 });
          try { resolve(new Response(stream, { status, headers })); } catch (error) { fail(error as Error); }
        },
        onResponseData(controller, chunk) {
          if (stopped || !chunk.byteLength) return;
          controller.pause();
          if (chunk.byteLength > 256 * 1024) { fail(new Error('Backend chunk overflow')); return; }
          // Pause before publishing one <=64KiB view; any tail stays bounded.
          if (held) { fail(new Error('Backend read ahead overflow')); return; }
          held = chunk; offset = 0; try { emit(); } catch { void close(); }
        },
        onResponseEnd() {
          ended = true; finish();
        },
        onResponseError(_controller, error) { fail(error); },
      });
    } catch (error) { fail(error as Error); }
  });
}
