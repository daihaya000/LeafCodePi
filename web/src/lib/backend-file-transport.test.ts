import { createServer, type Server, type RequestListener } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { openBackendFileSource } from "./backend-file-transport";
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });
async function backend(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it("preserves Range/status/HEAD headers and exact <=64KiB opaque bytes", async () => {
  const url = await backend((req, res) => { expect(req.headers.range).toBe("bytes=0-3"); res.writeHead(206, { "content-range": "bytes 0-3/100", "content-length": "4" }); res.end(Buffer.from([0, 1, 2, 255])); });
  const response = await openBackendFileSource(url, { headers: { range: "bytes=0-3" } }); expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe("bytes 0-3/100"); expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1, 2, 255]);
  const head = await openBackendFileSource(url, { method: "HEAD", headers: { range: "bytes=0-3" } }); expect(head.body).toBeNull(); expect(head.headers.get("content-length")).toBe("4");
});
it("splits coalesced parser chunks into exact <=64KiB views without losing EOF tails", async () => {
  const data = Buffer.alloc(2 * 1024 * 1024, 0x93);
  const url = await backend((_req, res) => { res.writeHead(200, { "content-length": data.length }); res.end(data); });
  const response = await openBackendFileSource(url, {}), reader = response.body!.getReader(); let total = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; expect(part.value.length).toBeLessThanOrEqual(65536); expect(part.value.every(b => b === 0x93)).toBe(true); total += part.value.length; } }
  finally { reader.releaseLock(); }
  expect(total).toBe(data.length);
});
it("forwards only the supplied private request and no automatic redirect/retry", async () => {
  let calls = 0; const url = await backend(async (req, res) => { calls++; expect(req.method).toBe("POST"); expect(req.headers.authorization).toBe("Bearer fixture"); const data: Buffer[] = []; for await (const p of req) data.push(p); expect(Buffer.concat(data).toString()).toBe("日本語"); res.writeHead(302, { location: "/replay" }); res.end("redirect"); });
  const response = await openBackendFileSource(url, { method: "POST", headers: { authorization: "Bearer fixture" }, body: new TextEncoder().encode("日本語").buffer }); expect(response.status).toBe(302); await response.body!.cancel(); expect(calls).toBe(1);
});
it("does not decode compressed private responses; relay can fail closed", async () => {
  const url = await backend((_req, res) => { res.writeHead(200, { "content-encoding": "gzip" }); res.end("opaque"); });
  const response = await openBackendFileSource(url, {}); expect(response.headers.get("content-encoding")).toBe("gzip"); expect(await response.text()).toBe("opaque");
});
it("propagates aborts before headers, mid-body and cancellation of an unread source", async () => {
  const url = await backend((req, res) => { if (req.url === "/wait") return; res.writeHead(200); res.write("start"); });
  const waiting = new AbortController(), pending = openBackendFileSource(url + "/wait", { signal: waiting.signal }); waiting.abort(); await expect(pending).rejects.toThrow();
  const control = new AbortController(), response = await openBackendFileSource(url, { signal: control.signal }), reader = response.body!.getReader(); await reader.read(); const part = reader.read(); control.abort(); await expect(part).rejects.toThrow("closed"); reader.releaseLock();
  const unread = await openBackendFileSource(url, {}); await unread.body!.cancel();
});
it("backpressure prevents an unread response draining a large source", async () => {
  let bytes = 0; const chunk = Buffer.alloc(65536); let done!: () => void; const closed = new Promise<void>(resolve => done = resolve);
  const url = await backend((_req, res) => { res.once("close", done); const pump = () => { while (!res.destroyed && bytes < 128 * 1024 * 1024) { bytes += chunk.length; if (!res.write(chunk)) { res.once("drain", pump); return; } } if (!res.destroyed) res.end(); }; pump(); });
  const response = await openBackendFileSource(url, {}); await delay(30); await response.body!.cancel(); await closed; expect(bytes).toBeLessThan(8 * 1024 * 1024);
});
