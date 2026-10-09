import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";
import { FILE_STREAM_HEADERS } from "../../shared/task-file-stream-contract.mjs";
/** One source read at a time; no whole-body accumulation, bounded drain wait, unconditional cancellation. */
export async function writeFileStream(response, source, signal, method, { stallMs = 45_000, maxChunkBytes = 64 * 1024 } = {}) {
  const headers = { [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) };
  for (const name of FILE_STREAM_HEADERS) { const value = source.headers.get(name); if (value !== null) headers[name] = value; }
  const reader = source.body?.getReader();
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted || response.destroyed) return;
    response.writeHead(source.status, headers);
    if (method === "HEAD" || !reader) { response.end(); return; }
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted || response.destroyed) break;
      if (value.byteLength > maxChunkBytes) throw new Error("File chunk overflow");
      if (!response.write(value)) await new Promise((resolve, reject) => {
        const finish = error => { clearTimeout(timer); response.off("drain", drain); response.off("close", closed); signal.removeEventListener("abort", closed); error ? reject(error) : resolve(); };
        const drain = () => finish(), closed = () => finish(new Error("Stream closed"));
        const timer = setTimeout(() => finish(new Error("Stream stalled")), stallMs); timer.unref?.();
        response.once("drain", drain); response.once("close", closed); signal.addEventListener("abort", closed, { once: true });
        if (signal.aborted || response.destroyed) closed();
      });
    }
    if (!signal.aborted && !response.destroyed) response.end();
  } catch { response.destroy(); }
  finally { signal.removeEventListener("abort", cancel); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}
