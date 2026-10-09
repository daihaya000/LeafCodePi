import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline, type Readable } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";

const CHUNK = 65536, MAX_SOURCE_CHUNK = 256 * 1024;
type Connection = { incoming?: IncomingMessage; decoded?: Readable; held?: Uint8Array };
const connections = new Set<Connection>();
export function readTtsEngineTransportDiagnostics() {
  return {
    ttsEngineConnections: connections.size,
    ttsEnginePendingHeaders: [...connections].filter(c => !c.incoming).length,
    ttsEngineHeldBytes: [...connections].reduce((n, c) => n + (c.held?.byteLength ?? 0), 0),
    ttsEngineQueuedBytes: [...connections].reduce((n, c) => n + (c.incoming?.readableLength ?? 0) + (c.decoded && c.decoded !== c.incoming ? c.decoded.readableLength : 0), 0),
  };
}
/** Public audio transport: native buffers, no fetch byte-stream copies or idle pool.
 * Cancellation applies to the returned read body, not an accepted header wait.
 */
export async function openStreamingTtsResponse(url: string, init: { body?: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<Response> {
  assertConfigurationOwner();
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error("Invalid TTS engine URL");
  return new Promise<Response>((resolve, reject) => {
    const connection: Connection = {};
    let req: ClientRequest, iterator: AsyncIterator<Buffer> | undefined, offset = 0;
    let closing: Promise<void> | undefined, closed: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => closing ??= (async () => {
      clearTimeout(timer); connection.held = undefined;
      req?.destroy(); connection.incoming?.destroy(); connection.decoded?.destroy();
      await iterator?.return?.().catch(() => {}); await closed;
      connections.delete(connection);
    })();
    try {
      // Node >=22 forwards the socket watermark; older HTTP typings omit it.
      const requestOptions = { method: 'POST', agent: false as const, highWaterMark: CHUNK,
        headers: { ...init.headers, 'accept-encoding': 'identity' } };
      req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, requestOptions, incoming => {
        connection.incoming = incoming;
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        const encoding = headers.get('content-encoding')?.trim().toLowerCase();
        let decoded: Readable = incoming;
        if (encoding && encoding !== 'identity') {
          const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip({ chunkSize: CHUNK })
            : encoding === 'deflate' ? createInflate({ chunkSize: CHUNK })
            : encoding === 'br' ? createBrotliDecompress({ chunkSize: CHUNK }) : null;
          if (!decoder) { reject(new Error('Unsupported TTS encoding')); void close(); return; }
          pipeline(incoming, decoder, () => {}); decoded = decoder;
        }
        connection.decoded = decoded; iterator = decoded[Symbol.asyncIterator]();
        if ([204, 205, 304].includes(incoming.statusCode ?? 0)) {
          void close().then(() => resolve(new Response(null, { status: incoming.statusCode, headers })), reject); return;
        }
        const body = new ReadableStream<Uint8Array>({
          async pull(output) {
            try {
              if (closing) throw new Error('TTS source closed');
              if (!connection.held) {
                const part = await iterator!.next();
                if (closing) throw new Error('TTS source closed');
                if (part.done) { await close(); output.close(); return; }
                if (!part.value.byteLength || part.value.byteLength > MAX_SOURCE_CHUNK) throw new Error('TTS source chunk overflow');
                connection.held = part.value; offset = 0;
              }
              const chunk = connection.held, end = Math.min(offset + CHUNK, chunk.byteLength);
              output.enqueue(chunk.subarray(offset, end)); offset = end;
              if (offset === chunk.byteLength) connection.held = undefined;
            } catch { await close(); output.error(new Error('TTS source unavailable')); }
          },
          async cancel() { await close(); },
        }, { highWaterMark: 0 });
        try { resolve(new Response(body, { status: incoming.statusCode ?? 502, headers })); }
        catch (error) { reject(error); void close(); }
      });
      closed = new Promise<void>(done => req.once('close', done));
      connections.add(connection);
      req.on('error', error => { reject(error); void close(); });
      req.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('TTS upgrade rejected')); void close(); });
      timer = setTimeout(() => { reject(new Error('TTS engine timeout')); void close(); }, init.timeoutMs ?? 60_000); timer.unref?.();
      req.end(init.body);
    } catch (error) { reject(error); void close(); }
  });
}
